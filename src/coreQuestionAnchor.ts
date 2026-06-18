/**
 * coreQuestionAnchor.ts — 核心問題動態錨定 (Core Question Anchor)
 *
 * Feature 3 of the Second Self system.
 *
 * After a note is refined, this module reads the user's IDENTITY.md
 * to extract the 3 core open questions, then sends the note summary
 * + core questions to the local LLM to determine if the note is
 * relevant to any of them.
 *
 * If relevant, it inserts a callout with a bidirectional link at the
 * top of the note, and appends a back-link under the matching question
 * in IDENTITY.md.
 */

import { App, Notice, TFile, normalizePath } from "obsidian";
import { LocalLLMClient, parseJsonFromLLM } from "./api";

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

const CORE_QUESTION_MATCH_PROMPT = `你是一位專注的研究助理。你的職責是判斷一篇新筆記是否與使用者的核心開放性問題有關。

你會收到兩組輸入：
1. 【新筆記摘要】：一篇剛精修筆記的核心內容。
2. 【核心問題列表】：使用者的 3 個核心開放性問題。

你的任務：
- 比對新筆記是否對任何核心問題提供了洞見、部分回答、新角度或相關資料。
- 僅在有實質關聯時才標記為相關。「泛泛的主題相近」不算相關。

嚴格輸出格式（JSON）：
{
  "matches": [
    {
      "questionIndex": 1,
      "relevance": "一句話說明此筆記如何與該核心問題相關"
    }
  ]
}

規則：
1. "questionIndex" 為 1-based（1、2 或 3）。
2. 若無相關，"matches" 為空陣列 []。
3. 一篇筆記可能與多個問題相關，但不要勉強配對。
4. 使用繁體中文撰寫 relevance。`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CoreQuestion {
  index: number;
  text: string;
}

interface MatchResult {
  matches: {
    questionIndex: number;
    relevance: string;
  }[];
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class CoreQuestionAnchor {
  constructor(
    private app: App,
    private apiClient: LocalLLMClient,
    private temperature: number,
    private secondSelfFolder: string,
    private identityFileName: string
  ) {}

  /**
   * Check if the refined note relates to any core questions in IDENTITY.md.
   * If so, inject callout in note and back-link in IDENTITY.md.
   *
   * @param file The refined note file.
   */
  async anchor(file: TFile): Promise<void> {
    try {
      // 1. Read and parse IDENTITY.md
      const identityFile = this.getIdentityFile();
      if (!identityFile) {
        console.log("[CoreQuestionAnchor] IDENTITY.md not found, skipping.");
        return;
      }

      const identityContent = await this.app.vault.read(identityFile);
      const questions = this.parseQuestions(identityContent);

      if (questions.length === 0) {
        console.log("[CoreQuestionAnchor] No core questions found in IDENTITY.md.");
        return;
      }

      // 2. Get note summary for comparison
      const noteContent = await this.app.vault.read(file);
      const noteBody = this.stripFrontmatter(noteContent);

      if (noteBody.trim().length < 50) return;

      // Extract summary for comparison
      const noteSummary = this.extractSummary(noteBody, file.basename);

      // 3. Send to LLM for matching
      const questionsText = questions
        .map((q) => `${q.index}. ${q.text}`)
        .join("\n");

      const userPrompt = [
        `【新筆記摘要】`,
        `標題：${file.basename}`,
        `內容：\n${noteSummary}\n`,
        `【核心問題列表】`,
        questionsText,
      ].join("\n");

      const rawResponse = await this.apiClient.prompt(
        CORE_QUESTION_MATCH_PROMPT,
        userPrompt,
        this.temperature
      );

      const parsed = parseJsonFromLLM<MatchResult>(rawResponse);

      if (!parsed || !Array.isArray(parsed.matches)) {
        console.error("[CoreQuestionAnchor] Invalid LLM response:", rawResponse);
        return;
      }

      if (parsed.matches.length === 0) {
        console.log(
          `[CoreQuestionAnchor] No core question matches for ${file.basename}.`
        );
        return;
      }

      // 4. Inject callout in the note
      await this.injectQuestionCallout(file, parsed.matches, questions);

      // 5. Add back-link in IDENTITY.md
      await this.addBackLinks(identityFile, file.basename, parsed.matches, questions);

      new Notice(
        `🎯 「${file.basename}」已錨定到 ${parsed.matches.length} 個核心問題！`
      );
    } catch (err) {
      console.error("[CoreQuestionAnchor] Error:", err);
      // Fail silently — anchoring is non-blocking
    }
  }

  // ---- Identity Parsing ---------------------------------------------------

  private getIdentityFile(): TFile | null {
    const identityPath = normalizePath(
      `${this.secondSelfFolder}/${this.identityFileName}`
    );
    const abstractFile = this.app.vault.getAbstractFileByPath(identityPath);
    if (abstractFile && abstractFile instanceof TFile) {
      return abstractFile as TFile;
    }
    return null;
  }

  /**
   * Parse the core questions from IDENTITY.md.
   * Expected format under `## 核心問題` heading:
   * 1. First question text
   * 2. Second question text
   * 3. Third question text
   */
  private parseQuestions(content: string): CoreQuestion[] {
    const questions: CoreQuestion[] = [];

    // Find the core questions section
    const sectionMatch = content.match(
      /## 核心問題[^\n]*\n([\s\S]*?)(?=\n## |$)/
    );
    if (!sectionMatch) return questions;

    const section = sectionMatch[1];
    const lineRegex = /^\s*(\d+)\.\s*(.+)/gm;
    let m;

    while ((m = lineRegex.exec(section)) !== null) {
      const text = m[2].trim();
      // Skip placeholder lines
      if (text.startsWith("[") && text.endsWith("]")) continue;
      if (text.length < 5) continue;

      questions.push({
        index: parseInt(m[1], 10),
        text,
      });
    }

    return questions;
  }

  // ---- Note Injection -----------------------------------------------------

  /**
   * Inject a core question callout at the top of the note body.
   */
  private async injectQuestionCallout(
    file: TFile,
    matches: MatchResult["matches"],
    questions: CoreQuestion[]
  ): Promise<void> {
    const content = await this.app.vault.read(file);
    const fmMatch = content.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
    const frontmatterStr = fmMatch ? fmMatch[0] : "";
    let bodyStr = content.substring(frontmatterStr.length);

    // Remove existing core question callouts to avoid stacking
    bodyStr = bodyStr
      .replace(/> \[!question\] 核心問題關聯[\s\S]*?(?=\n[^>]|\n$|$)/g, "")
      .trimStart();

    // Build callout
    const calloutLines = [`> [!question] 核心問題關聯`];

    for (const match of matches) {
      const question = questions.find((q) => q.index === match.questionIndex);
      if (question) {
        const identityBasename = this.identityFileName.replace(/\.md$/, "");
        calloutLines.push(
          `> - 🎯 [[${identityBasename}#問題${match.questionIndex}|核心問題 ${match.questionIndex}]]：${match.relevance}`
        );
      }
    }

    calloutLines.push("");

    const newContent =
      frontmatterStr + calloutLines.join("\n") + "\n" + bodyStr;
    await this.app.vault.modify(file, newContent);
  }

  /**
   * Add back-links in IDENTITY.md under the corresponding questions.
   */
  private async addBackLinks(
    identityFile: TFile,
    noteBasename: string,
    matches: MatchResult["matches"],
    questions: CoreQuestion[]
  ): Promise<void> {
    let content = await this.app.vault.read(identityFile);

    for (const match of matches) {
      const question = questions.find((q) => q.index === match.questionIndex);
      if (!question) continue;

      // Check if back-link already exists
      if (content.includes(`[[${noteBasename}]]`)) continue;

      // Find the question line and append after it
      const questionLine = `${question.index}. ${question.text}`;
      const idx = content.indexOf(questionLine);

      if (idx !== -1) {
        // Find the end of this line
        const lineEnd = content.indexOf("\n", idx);
        const insertPos = lineEnd !== -1 ? lineEnd : content.length;

        // Build back-link entry
        const today = new Date().toISOString().split("T")[0];
        const backLink = `\n   - (${today}) [[${noteBasename}]]：${match.relevance}`;

        content =
          content.substring(0, insertPos) +
          backLink +
          content.substring(insertPos);
      }
    }

    await this.app.vault.modify(identityFile, content);
  }

  // ---- Helpers ------------------------------------------------------------

  /**
   * Extract a summary from the note body for LLM comparison.
   */
  private extractSummary(body: string, basename: string): string {
    const parts: string[] = [];

    // Summary callout
    const summaryMatch = body.match(
      />\s*\[!summary\][^\n]*\n((?:>\s*.*\n?)*)/i
    );
    if (summaryMatch) {
      parts.push(
        summaryMatch[1]
          .split("\n")
          .map((l) => l.replace(/^>\s*/, ""))
          .join("\n")
          .trim()
      );
    }

    // Highlights
    const highlightsMatch = body.match(
      /## 重點提取\n([\s\S]*?)(?=\n## |$)/
    );
    if (highlightsMatch) {
      parts.push(highlightsMatch[1].trim().substring(0, 800));
    }

    // Reflection
    const reflectionMatch = body.match(
      />\s*\[!reflection\][^\n]*\n((?:>\s*.*\n?)*)/i
    );
    if (reflectionMatch) {
      parts.push(
        reflectionMatch[1]
          .split("\n")
          .map((l) => l.replace(/^>\s*/, ""))
          .join("\n")
          .trim()
      );
    }

    if (parts.length === 0) {
      return body.substring(0, 1500);
    }

    return parts.join("\n\n");
  }

  private stripFrontmatter(content: string): string {
    const fmRegex = /^---\s*\n[\s\S]*?\n---\s*\n?/;
    return content.replace(fmRegex, "").trim();
  }
}
