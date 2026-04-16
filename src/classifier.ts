import { App, TFile, Notice, normalizePath } from "obsidian";
import { LocalLLMClient, parseJsonFromLLM } from "./api";

const PILLARS = [
  "10_工作與管理",
  "20_學術與電腦科學",
  "30_生活與創作",
  "40_自託管實驗室",
  "00_收件箱"
];

const CLASSIFICATION_SYSTEM_PROMPT = `你是一個極度精確的分類引擎。請將知識組織到以下「五大支柱（Five Pillars）」中的其中一個：
- 10_工作與管理：團隊帶領、會議、專案管理（project management）、職場人際關係相關內容。
- 20_學術與電腦科學：電腦科學學位、大學課程作業、程式開發（programming）、技術學習相關內容。
- 30_生活與創作：美食部落格（台灣中部、日本在地美食）、旅遊規劃、個人興趣和創作相關內容。
- 40_自託管實驗室：家用伺服器設置（Mac Mini 2011）、Docker 容器化（containerization）、自託管服務、人工智慧（AI）工具測試相關內容。
- 00_收件箱：當內容無法強烈匹配任何分類時的預設分類。

你必須只回應有效的 JSON（valid JSON）格式。請精確遵循以下結構回應：
{
  "category": "<上述五大支柱中的其中一個>",
  "tags": ["<標籤1>", "<標籤2>", "<標籤3>"],
  "confidence": <介於 0.0 和 1.0 之間的浮點數>
}

規則：
1. "category" 必須完全符合五大支柱中的其中一個。
2. "tags" 必須包含 3 至 5 個具體的子主題。例如：「#Docker」、「#南投美食」。
3. "confidence" 必須反映你的確定程度。
4. 不可包含 Markdown 代碼區塊（markdown fences）或 JSON 物件外的任何文字。`;

interface ClassificationResult {
  category: string;
  tags: string[];
  confidence: number;
}

export class ClassificationEngine {
  constructor(
    private app: App,
    private apiClient: LocalLLMClient,
    private classificationTemperature: number
  ) {}

  public async classifyFile(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      const bodyContent = this.stripFrontmatter(content);

      if (bodyContent.includes("%% AI_Classified_at:")) {
        new Notice(`檔案「${file.basename}」已經分類過。`);
        return;
      }

      new Notice(`正在分類「${file.basename}」...`);

      const rawResponse = await this.apiClient.prompt(
        CLASSIFICATION_SYSTEM_PROMPT,
        bodyContent,
        this.classificationTemperature
      );
      
      const parsed = parseJsonFromLLM<ClassificationResult>(rawResponse);

      if (!parsed || typeof parsed.category !== "string" || !Array.isArray(parsed.tags) || typeof parsed.confidence !== "number") {
         new Notice("大型語言模型（LLM）回傳的 JSON 結構非預期。請檢查主控台。");
         console.error("[ClassificationEngine] Invalid response:", rawResponse);
         return;
      }

      const { category, tags, confidence } = parsed;

      let finalCategory = category;
      if (!PILLARS.includes(finalCategory)) {
        finalCategory = "00_Inbox"; // explicit fallback
      }

      const tagsToAdd = [...tags];
      let shouldMove = false;

      // Confidence Checks & Logic
      if (confidence < 0.7) {
        tagsToAdd.push("#AI-Uncertain");
      } else {
        const parentPath = file.parent?.path || "";
        // Only auto-migrate if currently in "00_Inbox" and category is different
        if (parentPath === "00_Inbox" && finalCategory !== "00_Inbox") {
          shouldMove = true;
        }
      }

      // 1. Process frontmatter with properties (category & tags)
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        frontmatter["category"] = finalCategory;
        const existingTags: string[] = Array.isArray(frontmatter["tags"]) ? frontmatter["tags"] : [];
        frontmatter["tags"] = Array.from(new Set([...existingTags, ...tagsToAdd]));
        
        // Remove 'last_classified' if it was left over from older version
        delete frontmatter["last_classified"];
      });

      // 2. Append hidden comment for state tracking
      const timestamp = new Date().toISOString().split("T")[0];
      const comment = `\n\n%% AI_Classified_at: ${timestamp} %%`;
      await this.app.vault.append(file, comment);

      // 3. Auto-Migration (Moving Files)
      if (shouldMove) {
        await this.moveFileToCategory(file, finalCategory);
        new Notice(`筆記已移動到 ${finalCategory}`);
      } else {
        if (confidence < 0.7) {
            new Notice(`分類完成（信心度（confidence）不足）。保留在收件箱/未確定狀態。`);
        } else {
            new Notice(`分類完成。`);
        }
      }

    } catch (err) {
      console.error("[ClassificationEngine] Error processing file:", err);
      new Notice(`分類失敗：${(err as Error).message}`);
    }
  }

  private async moveFileToCategory(file: TFile, category: string): Promise<void> {
    const destFolder = normalizePath(category);
    const abstractFolder = this.app.vault.getAbstractFileByPath(destFolder);
    
    // Check if the destination folder exists; if not, create it
    if (!abstractFolder) {
      await this.app.vault.createFolder(destFolder);
    }
    
    // Define the new location
    const newPath = normalizePath(`${category}/${file.name}`);
    await this.app.vault.rename(file, newPath);
  }

  private stripFrontmatter(content: string): string {
    const fmRegex = /^---\s*\n[\s\S]*?\n---\s*\n?/;
    return content.replace(fmRegex, "").trim();
  }
}
