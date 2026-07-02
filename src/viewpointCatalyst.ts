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

class ReflectionModal extends Modal {
  private highlights: string[];
  private questions: string[];
  private userInput: string = "";
  private onSubmit: (result: string | null) => void;
  private noteTitle: string;
  private currentStep: "summary" | "reflection" = "summary";
  private onSubmitCalled: boolean = false;

  constructor(
    app: App,
    noteTitle: string,
    highlights: string[],
    questions: string[],
    onSubmit: (result: string | null) => void
  ) {
    super(app);
    this.noteTitle = noteTitle;
    this.highlights = highlights;
    this.questions = questions;
    this.onSubmit = onSubmit;
  }

  private triggerSubmit(result: string | null) {
    if (!this.onSubmitCalled) {
      this.onSubmitCalled = true;
      this.onSubmit(result);
    }
  }

  onOpen(): void {
    this.render();
  }

  render(): void {
    const { contentEl } = this;
    contentEl.empty();

    if (this.currentStep === "summary") {
      this.renderSummary();
    } else {
      this.renderReflection();
    }
  }

  renderSummary(): void {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: `📝 閱讀摘要 — ${this.noteTitle}` });
    contentEl.createEl("p", {
      text: "請先閱讀以下精修摘要與重點提取，確認理解後再進行反思。",
      cls: "setting-item-description",
    });

    const highlightsDiv = contentEl.createDiv({ cls: "catalyst-highlights" });
    highlightsDiv.style.background = "var(--background-secondary)";
    highlightsDiv.style.padding = "12px 16px";
    highlightsDiv.style.borderRadius = "8px";
    highlightsDiv.style.marginBottom = "16px";
    highlightsDiv.style.maxHeight = "300px";
    highlightsDiv.style.overflowY = "auto";
    highlightsDiv.style.borderLeft = "4px solid var(--interactive-accent)";

    for (const highlight of this.highlights) {
      if (highlight && highlight.trim()) {
        highlightsDiv.createEl("p", {
          text: highlight.trim(),
          cls: "catalyst-highlight-item",
        });
      }
    }

    const buttonContainer = contentEl.createDiv({
      cls: "catalyst-button-container",
    });
    buttonContainer.style.display = "flex";
    buttonContainer.style.justifyContent = "flex-end";
    buttonContainer.style.gap = "8px";
    buttonContainer.style.marginTop = "8px";

    const nextBtn = buttonContainer.createEl("button", {
      text: "我已讀完，開始反思",
      cls: "mod-cta",
    });
    nextBtn.addEventListener("click", () => {
      this.currentStep = "reflection";
      this.render();
    });
  }

  renderReflection(): void {
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

    for (const q of this.questions) {
      if (q && q.trim()) {
        questionsDiv.createEl("p", {
          text: q.trim(),
          cls: "catalyst-question-item",
        });
      }
    }

    // Text area for user reflection
    new Setting(contentEl)
      .setName("你的反思")
      .setDesc("寫下你的簡短回答。允許回答不完整、使用碎句或半句。")
      .addTextArea((text) => {
        text.inputEl.style.width = "100%";
        text.inputEl.style.minHeight = "120px";
        text.inputEl.setAttr("rows", 6);
        text.inputEl.setAttr(
          "placeholder",
          "寫下你的簡短回答（可使用不完整句子、碎句、半句）..."
        );
        text.setValue(this.userInput);
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

    const prevBtn = buttonContainer.createEl("button", { text: "返回摘要" });
    prevBtn.addEventListener("click", () => {
      this.currentStep = "summary";
      this.render();
    });

    const skipBtn = buttonContainer.createEl("button", { text: "跳過反思" });
    skipBtn.addEventListener("click", () => {
      this.triggerSubmit(null);
      this.close();
    });

    const submitBtn = buttonContainer.createEl("button", {
      text: "提交反思",
      cls: "mod-cta",
    });
    submitBtn.addEventListener("click", () => {
      this.triggerSubmit(this.userInput.trim());
      this.close();
    });
  }

  onClose(): void {
    this.triggerSubmit(null);
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
   * Show modal to prompt user for catalyst question responses.
   * 
   * @param noteTitle The note title.
   * @param highlights The pre-generated highlights summary list.
   * @param questions The pre-generated questions list.
   * @returns The user's input string, or null if skipped.
   */
  async promptUser(noteTitle: string, highlights: string[], questions: string[]): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const modal = new ReflectionModal(
        this.app,
        noteTitle,
        highlights,
        questions,
        (reflection: string | null) => {
          resolve(reflection);
        }
      );
      modal.open();
    });
  }

  /**
   * Helper method to determine if a note is from an external source.
   */
  public async isExternalSource(file: TFile): Promise<boolean> {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;

    if (fm) {
      if (fm.type === "reference") return true;
      if (fm.source && typeof fm.source === "string" && fm.source.startsWith("http")) return true;
    }

    const parentPath = file.parent?.path || "";
    if (
      parentPath === "00_Inbox" ||
      parentPath === "00_收件箱" ||
      parentPath.startsWith("Clippings")
    ) {
      return true;
    }

    try {
      const rawContent = await this.app.vault.read(file);
      const fmMatch = rawContent.match(/^---\s*\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const fmBlock = fmMatch[1];
        if (/^type:\s*reference/m.test(fmBlock)) return true;
        const sourceMatch = fmBlock.match(/^source:\s*(.+)/m);
        if (sourceMatch && sourceMatch[1].trim().startsWith("http")) return true;
      }
    } catch {
      // ignore
    }

    return false;
  }
}
