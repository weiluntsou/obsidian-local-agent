import { App, TFile, Notice, normalizePath } from "obsidian";
import { LocalLLMClient, parseJsonFromLLM } from "./api";

const PILLARS = [
  "10_工作與管理",
  "20_學術與電腦科學",
  "30_生活與創作",
  "40_自託管實驗室",
  "00_收件箱"
];

const REFINER_SYSTEM_PROMPT = `你是一位專業的知識精修與摘要引擎。你的職責是處理原始筆記和文章，從中萃取最高品質的資訊信號。

你必須輸出恰好一個結構化的 JSON（JSON 資料格式）物件。請仔細閱讀輸入的筆記，並執行以下四個操作：

1. 摘要（SUMMARY）：提供對核心概念的簡潔摘要。
2. 關鍵詞彙（KEYWORDS）：提取技術用語（technical terms），並提供英文至繁體中文的詞彙對照表。如果原始文本已為中文，可略過此步或提供中文概念的英文譯詞。
3. 重點提取（HIGHLIGHTS）：謹挑選高價值、有實用性的段落或句子。重新清晰地改寫，去除所有樣板文本、冗餘內容和不必要的背景說明。
4. 原子化概念（ATOMIZATION）：如果文章中包含不同的、高價值的技巧、概念或思維模型（例如：特定的「執行緒管理（Thread Management）」技巧），請將其萃取為獨立的原子化筆記。
5. 分類（CLASSIFICATION）：將內容分類到五大支柱（Five Pillars）中的恰好一個。

五大支柱：
- 10_工作與管理
- 20_學術與電腦科學
- 30_生活與創作
- 40_自託管實驗室
- 00_收件箱

預期的 JSON 結構：
{
  "summary": "簡潔摘要...",
  "keywords": [
    { "en": "English Term", "zh": "繁體中文翻譯" }
  ],
  "highlights": [
    "高價值段落 1...",
    "高價值段落 2..."
  ],
  "atomicNotes": [
    {
      "title": "特定概念名稱",
      "content": "對該概念的詳細解釋...",
      "tags": ["#標籤1", "#標籤2"]
    }
  ],
  "category": "20_學術與電腦科學",
  "tags": ["#標籤1", "#標籤2", "#標籤3"],
  "confidence": 0.95
}

規則：
1. "category" 必須精確符合五大支柱中的其中一個。
2. "tags" 應包含 3 至 5 個子主題。
3. 在選擇重點提取時要評選謹慎。如果整篇文本毫無價值，"highlights" 可以為空。
4. "atomicNotes" 應只包含高度具體且可重複使用的洞見。如無不同的概念，不強行建立。
5. 「摘要」、「關鍵詞彙」（中文部分）、「重點提取」和「原子化筆記.內容」中的所有文本必須為繁體中文（zh-TW）。
6. 不可包含 Markdown 代碼區塊（markdown fences）、代碼片段或 JSON 物件外的任何文字。必須為有效的 JSON（valid JSON）。`;

interface RefinerResult {
  summary: string;
  keywords: { en: string; zh: string }[];
  highlights: string[];
  atomicNotes?: { title: string; content: string; tags: string[] }[];
  category: string;
  tags: string[];
  confidence: number;
}

export class NoteRefinerEngine {
  constructor(
    private app: App,
    private apiClient: LocalLLMClient,
    private temperature: number
  ) {}

  public async refineFile(file: TFile): Promise<void> {
    try {
      const originalContent = await this.app.vault.read(file);
      const bodyContent = this.stripFrontmatter(originalContent);

      if (bodyContent.trim().length === 0) {
        new Notice("筆記為空。沒有內容需要精修。");
        return;
      }

      new Notice(`正在精修「${file.basename}」...這可能需要一些時間。`);

      const rawResponse = await this.apiClient.prompt(
        REFINER_SYSTEM_PROMPT,
        bodyContent,
        this.temperature
      );

      const parsed = parseJsonFromLLM<RefinerResult>(rawResponse);

      if (!parsed || !parsed.summary || !Array.isArray(parsed.highlights)) {
        new Notice("大型語言模型（LLM）回傳的 JSON 結構非預期。請檢查主控台。");
        console.error("[NoteRefinerEngine] Invalid response:", rawResponse);
        return;
      }

      // 1. Create Atomic Notes
      const atomicLinks: string[] = [];
      if (parsed.atomicNotes && Array.isArray(parsed.atomicNotes)) {
        for (const atomic of parsed.atomicNotes) {
          const fileName = this.sanitizeFileName(atomic.title);
          const link = await this.createAtomicNote(fileName, atomic, parsed.category);
          if (link) {
            atomicLinks.push(link);
          }
        }
      }

      // 2. Build newly refined content
      const refinedBody = this.buildRefinedContent(parsed, atomicLinks);

      // 3. Update the original note (replace content, update frontmatter)
      let finalCategory = parsed.category;
      if (!PILLARS.includes(finalCategory)) {
        finalCategory = "00_收件箱";
      }

      const tagsToAdd = [...(parsed.tags || [])];
      let shouldMove = false;

      if (parsed.confidence < 0.7) {
        tagsToAdd.push("#AI-Uncertain");
      } else {
        const parentPath = file.parent?.path || "";
        if (parentPath === "00_收件箱" && finalCategory !== "00_收件箱") {
          shouldMove = true;
        }
      }
      
      // Update frontmatter
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        frontmatter["category"] = finalCategory;
        const existingTags: string[] = Array.isArray(frontmatter["tags"]) ? frontmatter["tags"] : [];
        frontmatter["tags"] = Array.from(new Set([...existingTags, ...tagsToAdd]));
        
        // Add a flag that this was refined
        frontmatter["refined"] = true;
      });

      // We read again to get the file with updated frontmatter, then replace its body
      const contentWithNewFrontmatter = await this.app.vault.read(file);
      const frontmatterMatch = contentWithNewFrontmatter.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
      const frontmatterStr = frontmatterMatch ? frontmatterMatch[0] : "";
      
      const newFullContent = frontmatterStr + refinedBody;
      await this.app.vault.modify(file, newFullContent);

      // 4. Move file if needed
      if (shouldMove) {
        await this.moveFileToCategory(file, finalCategory);
        new Notice(`精修完成並已移動到 ${finalCategory}`);
      } else {
        new Notice(`精修完成。`);
      }

    } catch (err) {
      console.error("[NoteRefinerEngine] Error processing file:", err);
      new Notice(`精修失敗：${(err as Error).message}`);
    }
  }

  private buildRefinedContent(parsed: RefinerResult, atomicLinks: string[]): string {
    const parts: string[] = [];

    // 1. Summary Block
    parts.push(`> [!summary] 摘要`);
    parts.push(`> ${parsed.summary.replace(/\\n/g, "\\n> ")}`);
    parts.push(``);

    // 2. Keywords Glossary
    if (parsed.keywords && Array.isArray(parsed.keywords) && parsed.keywords.length > 0) {
      parts.push(`> [!info] 關鍵詞彙對照表（Keywords 英文至繁體中文）`);
      for (const kw of parsed.keywords) {
        parts.push(`> - **${kw.en}**: ${kw.zh}`);
      }
      parts.push(``);
    }

    // 3. Highlights
    parts.push(`## 重點提取`);
    if (parsed.highlights.length > 0) {
      for (const hl of parsed.highlights) {
        parts.push(`${hl}`);
        parts.push(``);
      }
    } else {
      parts.push(`*（未發現特定有用段落）*`);
      parts.push(``);
    }

    // 4. Atomic Links
    if (atomicLinks.length > 0) {
      parts.push(`## 原子化概念筆記`);
      for (const link of atomicLinks) {
        parts.push(`- ${link}`);
      }
      parts.push(``);
    }

    const timestamp = new Date().toISOString().split("T")[0];
    parts.push(`%% AI_Refined_at: ${timestamp} %%`);

    return parts.join("\n");
  }

  private async createAtomicNote(
    fileName: string, 
    data: { content: string; tags: string[] },
    category: string
  ): Promise<string | null> {
    try {
      let finalCategory = category;
      if (!PILLARS.includes(finalCategory)) {
         finalCategory = "00_收件箱";
      }

      const destFolder = normalizePath(finalCategory);
      const abstractFolder = this.app.vault.getAbstractFileByPath(destFolder);
      if (!abstractFolder) {
        await this.app.vault.createFolder(destFolder);
      }

      // Ensure unique filename
      let attempt = 0;
      let finalPath = normalizePath(`${finalCategory}/${fileName}.md`);
      while (this.app.vault.getAbstractFileByPath(finalPath)) {
        attempt++;
        finalPath = normalizePath(`${finalCategory}/${fileName} ${attempt}.md`);
      }

      const timestamp = new Date().toISOString();
      const tagsStr = data.tags && data.tags.length > 0 
        ? `tags:\n  - ${data.tags.map(t => t.replace(/^#/, "")).join("\\n  - ")}`
        : "tags: []";

      const fullContent = `---
type: atomic-note
category: ${finalCategory}
${tagsStr}
created: ${timestamp}
---

# ${fileName}

${data.content}
`;

      await this.app.vault.create(finalPath, fullContent);
      return `[[${finalPath.replace(".md", "")}|${fileName}]]`;

    } catch (err) {
      console.error("[NoteRefinerEngine] Failed to create atomic note:", err);
      return null;
    }
  }

  private sanitizeFileName(name: string): string {
    return name.replace(/[\\/:"*?<>|#^\[\]]/g, "").trim() || "Atomic Note";
  }

  private async moveFileToCategory(file: TFile, category: string): Promise<void> {
    const destFolder = normalizePath(category);
    const abstractFolder = this.app.vault.getAbstractFileByPath(destFolder);
    
    if (!abstractFolder) {
      await this.app.vault.createFolder(destFolder);
    }
    
    const newPath = normalizePath(`${category}/${file.name}`);
    await this.app.vault.rename(file, newPath);
  }

  private stripFrontmatter(content: string): string {
    const fmRegex = /^---\s*\n[\s\S]*?\n---\s*\n?/;
    return content.replace(fmRegex, "").trim();
  }
}
