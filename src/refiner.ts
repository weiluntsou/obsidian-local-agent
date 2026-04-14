import { App, TFile, Notice, normalizePath } from "obsidian";
import { LocalLLMClient, parseJsonFromLLM } from "./api";

const PILLARS = [
  "10_Work_&_Management",
  "20_Academic_CS",
  "30_Life_&_Creations",
  "40_Self_Hosted_Lab",
  "00_Inbox"
];

const REFINER_SYSTEM_PROMPT = `You are an expert knowledge refiner and summarisation engine. Your job is to process raw notes and articles, and extract the highest quality signal from the noise.

You will output exactly ONE structured JSON object. Read the input note carefully and perform these four operations:

1. SUMMARY: Provide a concise summary of the core idea.
2. KEYWORDS: Extract key technical terms and provide an English-to-Traditional Chinese glossary. If the original text is already in Chinese, you can ignore this or provide English terms for Chinese concepts.
3. HIGHLIGHTS: Extract ONLY the highly valuable, useful paragraphs or sentences. Rewrite them clearly. Remove all boilerplate, fluff, and unnecessary context.
4. ATOMIZATION: If there are distinct, highly valuable techniques, concepts, or mental models (e.g. a specific "Thread Management" trick), extract them into separate atomic notes.
5. CLASSIFICATION: Classify the content into exactly ONE of the Five Pillars.

Five Pillars:
- 10_Work_&_Management
- 20_Academic_CS
- 30_Life_&_Creations
- 40_Self_Hosted_Lab
- 00_Inbox

Expected JSON structure:
{
  "summary": "Concise summary...",
  "keywords": [
    { "en": "English Term", "zh": "Traditional Chinese Translation" }
  ],
  "highlights": [
    "Useful paragraph 1...",
    "Useful paragraph 2..."
  ],
  "atomicNotes": [
    {
      "title": "Specific Concept Name",
      "content": "Detailed explanation of the concept...",
      "tags": ["#tag1", "#tag2"]
    }
  ],
  "category": "20_Academic_CS",
  "tags": ["#tag1", "#tag2", "#tag3"],
  "confidence": 0.95
}

Rules:
1. "category" MUST exactly match one of the Five Pillars.
2. "tags" should contain 3-5 sub-topics.
3. Be highly selective with highlights. If the whole text is garbage, "highlights" can be empty.
4. "atomicNotes" should only contain highly specific, reusable insights. Do not force it if there are no distinct concepts.
5. All text in "summary", "keywords" (zh), "highlights", and "atomicNotes.content" should be in Traditional Chinese (zh-TW).
6. Do NOT include markdown fences, code blocks, or text outside the JSON object. Just valid JSON.`;

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
        new Notice("Note is empty. Nothing to refine.");
        return;
      }

      new Notice(`Refining "${file.basename}"... This might take a while.`);

      const rawResponse = await this.apiClient.prompt(
        REFINER_SYSTEM_PROMPT,
        bodyContent,
        this.temperature
      );

      const parsed = parseJsonFromLLM<RefinerResult>(rawResponse);

      if (!parsed || !parsed.summary || !Array.isArray(parsed.highlights)) {
        new Notice("LLM returned unexpected JSON structure. Check console.");
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
        finalCategory = "00_Inbox";
      }

      const tagsToAdd = [...(parsed.tags || [])];
      let shouldMove = false;

      if (parsed.confidence < 0.7) {
        tagsToAdd.push("#AI-Uncertain");
      } else {
        const parentPath = file.parent?.path || "";
        if (parentPath === "00_Inbox" && finalCategory !== "00_Inbox") {
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
        new Notice(`Refined & moved to ${finalCategory}`);
      } else {
        new Notice(`Refinement complete.`);
      }

    } catch (err) {
      console.error("[NoteRefinerEngine] Error processing file:", err);
      new Notice(`Refinement failed: ${(err as Error).message}`);
    }
  }

  private buildRefinedContent(parsed: RefinerResult, atomicLinks: string[]): string {
    const parts: string[] = [];

    // 1. Summary Block
    parts.push(`> [!summary] Summary`);
    parts.push(`> ${parsed.summary.replace(/\\n/g, "\\n> ")}`);
    parts.push(``);

    // 2. Keywords Glossary
    if (parsed.keywords && Array.isArray(parsed.keywords) && parsed.keywords.length > 0) {
      parts.push(`> [!info] 關鍵字對照表 (Keywords)`);
      for (const kw of parsed.keywords) {
        parts.push(`> - **${kw.en}**: ${kw.zh}`);
      }
      parts.push(``);
    }

    // 3. Highlights
    parts.push(`## Highlights (高亮)`);
    if (parsed.highlights.length > 0) {
      for (const hl of parsed.highlights) {
        parts.push(`${hl}`);
        parts.push(``);
      }
    } else {
      parts.push(`*(No specific useful paragraphs extracted)*`);
      parts.push(``);
    }

    // 4. Atomic Links
    if (atomicLinks.length > 0) {
      parts.push(`## 原子化筆記 (Atomic Concepts)`);
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
         finalCategory = "00_Inbox";
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
