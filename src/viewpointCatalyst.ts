/**
 * viewpointCatalyst.ts — 觀點強制催化器 (Viewpoint Catalyst)
 *
 * Feature 1 of the Second Self system.
 *
 * After a note from an external source (type: reference) is refined,
 * this module checks whether the user has added personal reflection.
 * If not, it generates targeted challenge questions via the local LLM
 * and presents a blocking Modal for the user to input their critical
 * thinking, stance challenges, or intuitive reactions.
 *
 * The reflection is injected as a callout at the end of the note.
 * Pure content summaries are explicitly forbidden — only critical
 * engagement is solicited.
 */

import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { LocalLLMClient } from "./api";

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

const CATALYST_QUESTION_PROMPT = `你是一位蘇格拉底式的思維催化師。你的職責是讓使用者對剛讀完的內容進行深度的批判性思考。

你會收到一篇已精修筆記的摘要與重點提取。請根據內容生成恰好 3 個具挑戰性的開放式問題。

嚴格規則：
1. 嚴禁產出任何內容摘要性質的問題（例如「這篇文章的主要觀點是什麼？」）。
2. 每個問題必須迫使使用者表態、挑戰預設立場或連結到個人經驗。
3. 問題應該引導出「我不同意…因為…」或「這讓我想到…但實際上…」的回答。
4. 使用繁體中文。
5. 只輸出 3 個問題（numbered list），不要其他文字。

問題類型範例（不要照抄，只是啟發方向）：
- 立場挑戰：「你同意作者的論點嗎？如果你是反方，你會如何反駁？」
- 個人連結：「這個觀點與你過去的經驗有什麼衝突？」
- 盲點偵測：「作者可能忽略了什麼關鍵假設？」`;

// ---------------------------------------------------------------------------
// Reflection Input Modal
// ---------------------------------------------------------------------------

class ReflectionModal extends Modal {
  private questions: string;
  private userInput: string = "";
  private onSubmit: (result: string | null) => void;
  private noteTitle: string;

  constructor(
    app: App,
    noteTitle: string,
    questions: string,
    onSubmit: (result: string | null) => void
  ) {
    super(app);
    this.noteTitle = noteTitle;
    this.questions = questions;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: "🧠 觀點催化器 — 個人反思" });
    contentEl.createEl("p", {
      text: `你剛精修了「${this.noteTitle}」。在歸檔前，請花一分鐘寫下你的批判性思考。`,
      cls: "setting-item-description",
    });

    // Display generated questions
    const questionsDiv = contentEl.createDiv({ cls: "catalyst-questions" });
    questionsDiv.style.background = "var(--background-secondary)";
    questionsDiv.style.padding = "12px 16px";
    questionsDiv.style.borderRadius = "8px";
    questionsDiv.style.marginBottom = "16px";
    questionsDiv.style.borderLeft = "4px solid var(--interactive-accent)";

    const lines = this.questions.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      questionsDiv.createEl("p", {
        text: line,
        cls: "catalyst-question-item",
      });
    }

    // Text area for user reflection
    new Setting(contentEl)
      .setName("你的反思")
      .setDesc("寫下你的批判、立場挑戰或直覺想法。嚴禁純內容摘要。")
      .addTextArea((text) => {
        text.inputEl.style.width = "100%";
        text.inputEl.style.minHeight = "120px";
        text.inputEl.setAttr("rows", 6);
        text.inputEl.setAttr(
          "placeholder",
          "例如：我不同意作者認為...的觀點，因為在我的經驗中..."
        );
        text.onChange((value) => {
          this.userInput = value;
        });
      });

    // Action buttons
    const buttonContainer = contentEl.createDiv({
      cls: "catalyst-button-container",
    });
    buttonContainer.style.display = "flex";
    buttonContainer.style.justifyContent = "flex-end";
    buttonContainer.style.gap = "8px";
    buttonContainer.style.marginTop = "8px";

    const skipBtn = buttonContainer.createEl("button", { text: "跳過反思" });
    skipBtn.addEventListener("click", () => {
      this.close();
      this.onSubmit(null);
    });

    const submitBtn = buttonContainer.createEl("button", {
      text: "提交反思",
      cls: "mod-cta",
    });
    submitBtn.addEventListener("click", () => {
      if (this.userInput.trim().length < 10) {
        new Notice("反思內容太短了！請至少寫 10 個字。");
        return;
      }
      this.close();
      this.onSubmit(this.userInput.trim());
    });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class ViewpointCatalyst {
  constructor(
    private app: App,
    private apiClient: LocalLLMClient,
    private temperature: number
  ) {}

  /**
   * Check if the note needs viewpoint challenge, and if so, prompt the user.
   *
   * @param file The refined note file.
   * @returns Promise that resolves when the catalyst flow completes.
   */
  async challenge(file: TFile): Promise<void> {
    try {
      // 1. Check if this note is from an external source
      if (!this.isExternalSource(file)) {
        console.log(
          `[ViewpointCatalyst] ${file.basename} is not external source, skipping.`
        );
        return;
      }

      // 2. Check if reflection already exists
      const content = await this.app.vault.read(file);
      if (this.hasReflection(content)) {
        console.log(
          `[ViewpointCatalyst] ${file.basename} already has reflection, skipping.`
        );
        return;
      }

      // 3. Generate challenge questions
      const bodyContent = this.stripFrontmatter(content);
      const truncatedBody = bodyContent.substring(0, 2000); // Limit context size

      new Notice("🧠 正在生成觀點催化問題...");

      const questions = await this.apiClient.prompt(
        CATALYST_QUESTION_PROMPT,
        `以下是剛精修完成的筆記「${file.basename}」的內容：\n\n${truncatedBody}`,
        this.temperature
      );

      // 4. Show modal and wait for user response
      return new Promise<void>((resolve) => {
        const modal = new ReflectionModal(
          this.app,
          file.basename,
          questions,
          async (reflection: string | null) => {
            if (reflection) {
              // Inject reflection into note
              await this.injectReflection(file, reflection, questions);
              new Notice("✅ 個人反思已注入筆記！");
            } else {
              // Mark as skipped in frontmatter
              await this.app.fileManager.processFrontMatter(
                file,
                (frontmatter) => {
                  frontmatter["reflection_skipped"] = true;
                }
              );
              new Notice("已跳過反思。可以隨時回來補充。");
            }
            resolve();
          }
        );
        modal.open();
      });
    } catch (err) {
      console.error("[ViewpointCatalyst] Error:", err);
      new Notice(`觀點催化器錯誤：${(err as Error).message}`);
    }
  }

  /**
   * Determine if a note is from an external source.
   * Checks frontmatter for type: reference, or source URL presence.
   */
  private isExternalSource(file: TFile): boolean {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache?.frontmatter) return false;

    const fm = cache.frontmatter;

    // Has explicit type: reference
    if (fm.type === "reference") return true;

    // Has a source URL
    if (fm.source && typeof fm.source === "string" && fm.source.startsWith("http")) {
      return true;
    }

    // Is in a typical source/inbox folder
    const parentPath = file.parent?.path || "";
    if (
      parentPath === "00_Inbox" ||
      parentPath === "00_收件箱" ||
      parentPath.startsWith("Clippings")
    ) {
      return true;
    }

    return false;
  }

  /**
   * Check if the note already contains a reflection section.
   */
  private hasReflection(content: string): boolean {
    return (
      content.includes("> [!reflection]") ||
      content.includes("## 個人反思") ||
      content.includes("## Personal Reflection")
    );
  }

  /**
   * Inject the user's reflection into the end of the note as a callout.
   */
  private async injectReflection(
    file: TFile,
    reflection: string,
    questions: string
  ): Promise<void> {
    const content = await this.app.vault.read(file);
    const timestamp = new Date().toISOString().split("T")[0];

    const reflectionBlock = [
      "",
      `> [!reflection] 個人反思 (${timestamp})`,
      `> **催化問題：**`,
      ...questions
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => `> ${l}`),
      `>`,
      `> **我的思考：**`,
      ...reflection.split("\n").map((l) => `> ${l}`),
      "",
    ].join("\n");

    await this.app.vault.modify(file, content + reflectionBlock);

    // Update frontmatter
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter["has_reflection"] = true;
      delete frontmatter["reflection_skipped"];
    });
  }

  private stripFrontmatter(content: string): string {
    const fmRegex = /^---\s*\n[\s\S]*?\n---\s*\n?/;
    return content.replace(fmRegex, "").trim();
  }
}
