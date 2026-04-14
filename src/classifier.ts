import { App, TFile, Notice, normalizePath } from "obsidian";
import { LocalLLMClient, parseJsonFromLLM } from "./api";

const PILLARS = [
  "10_Work_&_Management",
  "20_Academic_CS",
  "30_Life_&_Creations",
  "40_Self_Hosted_Lab",
  "00_Inbox"
];

const CLASSIFICATION_SYSTEM_PROMPT = `You are a highly precise classification engine. Organize knowledge into ONE of the following Five Pillars exact names:
- 10_Work_&_Management: Content related to team leading, meetings, project management, and professional networking.
- 20_Academic_CS: Content related to Computer Science degree studies, UoPeople assignments, and technical learning.
- 30_Life_&_Creations: Content related to food blogging (local delicacies in central Taiwan/Japan), travel plans, and personal hobbies.
- 40_Self_Hosted_Lab: Content related to home server setup (Mac Mini 2011), Docker, self-hosted services, and AI tool testing.
- 00_Inbox: The default fallback if no strong match is found.

You MUST respond with valid JSON only. Keep the response exactly in this schema:
{
  "category": "<one of the five exact folder names above>",
  "tags": ["<tag1>", "<tag2>", "<tag3>"],
  "confidence": <float between 0.0 and 1.0>
}

Rules:
1. "category" MUST exactly match one of the Five Pillars.
2. "tags" must contain 3-5 specific sub-topics (e.g., "#Docker", "#NantouFood").
3. "confidence" must reflect your certainty.
4. Do NOT include markdown fences, code blocks, or text outside the JSON object.`;

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
        new Notice(`File "${file.basename}" is already classified.`);
        return;
      }

      new Notice(`Classifying "${file.basename}"...`);

      const rawResponse = await this.apiClient.prompt(
        CLASSIFICATION_SYSTEM_PROMPT,
        bodyContent,
        this.classificationTemperature
      );
      
      const parsed = parseJsonFromLLM<ClassificationResult>(rawResponse);

      if (!parsed || typeof parsed.category !== "string" || !Array.isArray(parsed.tags) || typeof parsed.confidence !== "number") {
         new Notice("LLM returned unexpected JSON structure. Check console.");
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
        new Notice(`Note moved to ${finalCategory}`);
      } else {
        if (confidence < 0.7) {
            new Notice(`Classification complete (low confidence). Kept as Inbox/Uncertain.`);
        } else {
            new Notice(`Classification complete.`);
        }
      }

    } catch (err) {
      console.error("[ClassificationEngine] Error processing file:", err);
      new Notice(`Classification failed: ${(err as Error).message}`);
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
