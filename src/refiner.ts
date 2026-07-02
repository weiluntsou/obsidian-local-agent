import { App, TFile, Notice, normalizePath } from "obsidian";
import { LocalLLMClient, parseJsonFromLLM } from "./api";
import { ViewpointCatalyst } from "./viewpointCatalyst";
import { ContradictionRadar } from "./contradictionRadar";
import { CoreQuestionAnchor } from "./coreQuestionAnchor";

/**
 * Ontology snapshot: captures the semantic relationships (wikilinks,
 * tags, frontmatter properties) of a note before any LLM rewriting.
 * After processing, any links or tags missing from the LLM output
 * are re-injected to preserve the knowledge graph.
 */
interface OntologySnapshot {
  /** All [[wikilink]] targets found in the original body text. */
  wikilinks: string[];
  /** All #tags found in the original body text (not frontmatter). */
  inlineTags: string[];
  /** Frontmatter tags (array of strings without leading #). */
  frontmatterTags: string[];
  /** Frontmatter key-value pairs to preserve across rewrites. */
  preservedFrontmatter: Record<string, unknown>;
  /** All @handles found in the original body text. */
  handles: string[];
  /** All markdown links or external URLs. */
  externalLinks: string[];
  /** All images/attachments markup. */
  images: string[];
}

const PILLARS = [
  "10_工作與管理",
  "20_學術與電腦科學",
  "30_生活與創作",
  "40_自託管實驗室",
  "00_收件箱"
];

const REFINER_SYSTEM_PROMPT = `你是一位專業的知識精修與摘要引擎。你的職責是處理原始筆記和文章，從中萃取最高品質的資訊信號。

你必須輸出恰好一個結構化的 JSON（JSON 資料格式）物件。請仔細閱讀輸入的筆記（包含檔名作為參考），並執行以下六個操作：

1. 標題優化（TITLE）：評估原始標題是否與內容高度相關。如果無關或是無意義名稱，請根據內容給出一個20字以內的新繁體中文標題。如果原始標題包含日期資訊（如 2026-04-17），必須保留於新標題中。若原標題已經貼切貼於內容，請直接回傳原標題。
2. 原文關鍵句摘錄（ORIGINAL_QUOTES）：從原始英文文本中挑選並「逐字摘錄」3 至 5 句最核心、最有節奏感且獨立成立的英文關鍵句。
3. 關鍵詞彙對照表（KEYWORDS）：從文章中提取 3 至 5 個真實出現在文章中的專有名詞/技術用語（technical terms），並提供英文至繁體中文的詞彙對照表。絕對不可自創或組合原文中未曾出現的複合詞（例如，不可將文章中分開出現的 sustainable 與 artifact 融合成 sustainable artifact / 可持續性工件，必須是獨立出現且真實存在的詞彙）。
4. 摘要與重點提取（HIGHLIGHTS）：合併摘要跟重點提取。必須在 "highlights" 陣列的第一個元素放入對核心概念的簡潔總結（摘要，約一至二句話，簡述文章核心論點）。隨後的元素為謹挑選高價值、有實用性的重點提取（3 至 5 點，忠於原文，不加入任何新資訊，去除所有樣板文本、冗餘內容及不必要的背景說明）。
5. 催化問題（CATALYST_QUESTIONS）：生成 1 至 3 個緊扣文章範圍的催化思考問題。
   - 題目必須能只用這篇文章的內容回答，絕對不能要求使用者動用文章以外的產業知識或做開放式價值判斷（例如「我們是否投入過多資源」這種題目要淘汰）。
   - 題目形式優先用「如果應用在你的情境會怎樣」，而不是「你對這個現象的整體看法是什麼」。
6. 分類（CLASSIFICATION）：將內容分類到五大支柱（Five Pillars）中的恰好一個。

五大支柱：
- 10_工作與管理
- 20_學術與電腦科學
- 30_生活與創作
- 40_自託管實驗室
- 00_收件箱

預期的 JSON 結構（注意 originalQuotes 放在最前，讓您先進行摘錄再做後續精修）：
{
  "suggestedTitle": "新的或原來的標題",
  "originalQuotes": [
    { "quote": "英文原句，逐字複製，不改寫不翻譯", "source": "出處段落關鍵字或小標題" }
  ],
  "keywords": [
    { "en": "English Term", "zh": "繁體中文翻譯" }
  ],
  "highlights": [
    "對核心概念的一至二句話簡潔總結（摘要）",
    "高價值重點 1...",
    "高價值重點 2..."
  ],
  "catalystQuestions": [
    "如果你現在設計一個 agent prompt，靜態前綴要放哪些內容，才不會讓快取失效？",
    "你過去寫過的 prompt 裡，有沒有可能順序問題而觸發過 cache miss？"
  ],
  "category": "20_學術與電腦科學",
  "tags": ["#標籤1", "#標籤2", "#標籤3"],
  "confidence": 0.95
}

規則：
1. "category" 必須精確符合五大支柱中的其中一個。
2. "tags" 應包含 3 至 5 個子主題。
3. "originalQuotes" 規則：
   - 必須是原文逐字複製，禁止改寫、簡化、翻譯。
   - 挑選標準：句子本身要有獨立完整的意義（不能是「it changed everything」這種需要前後文才懂的句子）。
   - 優先挑選有節奏感、修辭手法（對仗、重複、反轉）的句子。
   - 字數上限：每句不超過 40 字，避免摘錄整段。
   - 每句後面不附中文翻譯。
   - 必須挑選 3 到 5 句。
4. 重點提取規則：必須忠於原文，不加入摘要及文章以外的新資訊，數量限制 3 至 5 點。若整篇文本毫無價值，第一個元素放摘要後，其餘 highlights 可以為空。
5. "catalystQuestions" 應為 1 到 3 個與文章內容緊扣的問題，用以啟發使用者將其應用於自身情境。
6. 「關鍵詞彙」（中文部分）和「重點提取」中的所有文本必須為繁體中文（zh-TW）。
7. 「反思（Reflection）」區塊為使用者手動維護區，系統僅生成區塊標題與格式骨架，不得填入任何內文，亦不得在 JSON 中輸出「反思」區塊的內容，違反此規則視為格式錯誤。
8. 為了增加知識庫的關聯性，請參考輸入中提供的「知識庫現有標籤」列表。如果內容與現有標籤相關，請優先選用這些已存在的標籤。若現有標籤皆不適用，方可根據內容生成新的標籤。標籤格式須以「#」開頭。
9. 請參考輸入中提供的「關聯筆記候選清單」。若在撰寫「重點提取」內容時提到候選清單中的概念或頁面，請使用雙層括號 '[[筆記名稱]]'（例如 [[Docker]]）進行雙向連結，建立知識網路。
10. 關鍵詞彙對照表規則：只能使用文章中真實出現的詞，不可自創複合詞，數量限 3 到 5 個。`;

const EVALUATE_AND_REFLECT_SYSTEM_PROMPT = `你是一位專業的知識分析與思維判讀引擎。
你會收到：
1. 筆記的摘要與重點提取。
2. 催化問題（1-3題）。
3. 使用者對催化問題的簡短回答。

請執行以下判讀與生成任務，並輸出恰好一個結構化的 JSON（JSON 資料格式）物件：

1. 判讀思考痕跡（PASSED）：
   AI 讀使用者對催化問題的回答，判斷思考痕跡深淺。判斷依據只看質，不看量：
   - 有沒有出現「我覺得」「應該是」「但」「如果」這類代表使用者在下判斷、而非單純複述的語言標記。
   - 有沒有具體connect到使用者自己的情境／過去經驗（哪怕只有一句話）。
   - 即使只有半句、字數很少，只要方向是「回應問題」而非「留白／無意義內容／純複製文章句子」，就算通過（passed 設為 true）。
   - 如果完全空白、純複製文章句子、或是回答與問題完全無關的胡言亂語，則判定不通過（passed 設為 false）。

2. 自動決定拆解深度：
   - 若 passed 為 true（通過）：
     - atomicNotes（原子化概念）：提取文章中高價值的獨立概念，並生成原子筆記。
       【標題前綴規則】：標題（title）前綴可用「〔衍生〕」與原文直接內容做區分；數量對應文章實際的獨立子概念，不強行拆分。
       【核心定義規則】：你必須「直接把使用者對催化問題的回答」，作為原子筆記的開場定義句（第一句話），絕對不能重新用文章的話去寫！
       在定義句之後，**必須增加更多概念拆解的條列化（Bullet points）部分**，使用無序列表（例如 \`- **核心要素/關鍵原則**：...\`）詳細條列拆解出該概念的核心要素、細分機制、運作步驟或具體場景。避免大段落文字，要條列分明以增強結構性與可讀性。
     - relatedLinks（相關連結與原因）：分析使用者知識庫中可能關聯的筆記，列出相關連結並附上具體理由（包含推薦該關聯的原因）。格式為陣列，包含 { "noteName": "連結名稱", "reason": "推薦理由" }。找不出來理由則不得掛此連結。
   - 若 passed 為 false（沒通過）：
     - atomicNotes 必須為空陣列。
     - relatedLinks 必須為空陣列。
     - lightweightLabel（輕量標籤）：生成一句話的輕量標籤，例如：對此主題的簡短一句話分類或核心屬性描述（繁體中文，約10-20字），作為沒通過時的輕量記錄。

預期的 JSON 結構：
{
  "passed": true,
  "atomicNotes": [
    {
      "title": "概念名稱",
      "content": "使用者的回答（作為第一句）。\n\n- **核心機制/關鍵要素 1**：詳細說明項目 1...\n- **應用方式/具體步驟 2**：詳細說明項目 2...\n- **核心原則/限制場景 3**：詳細說明項目 3...",
      "tags": ["#標籤1", "#標籤2"]
    }
  ],
  "relatedLinks": [
    { "noteName": "相關筆記名稱", "reason": "因為您在回答中提到..." }
  ],
  "lightweightLabel": ""
}
`;

interface RefinerResult {
  suggestedTitle: string;
  originalQuotes?: { quote: string; source: string }[];
  keywords: { en: string; zh: string }[];
  highlights: string[];
  category: string;
  tags: string[];
  confidence: number;
  catalystQuestions?: string[];
}

interface Phase2Result {
  passed: boolean;
  atomicNotes: { title: string; content: string; tags: string[] }[];
  relatedLinks: { noteName: string; reason: string }[];
  lightweightLabel: string;
}

export class NoteRefinerEngine {
  private secondSelfFolder: string;
  private identityFileName: string;

  constructor(
    private app: App,
    private apiClient: LocalLLMClient,
    private temperature: number,
    secondSelfFolder: string = "04_Second_Self",
    identityFileName: string = "IDENTITY.md"
  ) {
    this.secondSelfFolder = secondSelfFolder;
    this.identityFileName = identityFileName;
  }

  public async refineFile(file: TFile): Promise<void> {
    try {
      const originalContent = await this.app.vault.read(file);
      const bodyContent = this.stripFrontmatter(originalContent);

      if (bodyContent.trim().length === 0) {
        new Notice("筆記為空。沒有內容需要精修。");
        return;
      }

      // ── Ontology Preservation: capture relationships before rewrite ──
      const ontology = this.captureOntology(originalContent);

      // Get all existing tags in the vault to help LLM reuse them
      const allVaultTagsMap = (this.app.metadataCache as any).getTags() as Record<string, number>;
      const sortedTags = Object.entries(allVaultTagsMap)
        .sort((a, b) => b[1] - a[1]) // Sort by frequency (most used first)
        .map(([tag]) => tag); // e.g. "#tagname"

      // Limit to top 150 tags to avoid overloading LLM context
      const tagListLimit = 150;
      const limitedTags = sortedTags.slice(0, tagListLimit);
      const existingTagsContext = limitedTags.length > 0
        ? `\n\n【知識庫現有標籤（供參考，請優先選用相關的標籤以增加關連性，亦可自行發明新標籤）：】\n${limitedTags.join(", ")}`
        : "";

      // Find initial related note candidates based on original tags
      const originalTags = [...ontology.inlineTags, ...ontology.frontmatterTags];
      const initialRelated = this.findRelatedNotes(file, originalTags, [], file.basename, new Set(), 10);
      const relatedContext = initialRelated.length > 0
        ? `\n\n【關聯筆記候選清單（供參考引用，若內容合適，請在輸出中使用 [[筆記名稱]] 進行雙向連結）：】\n${initialRelated.map(t => `- ${t}`).join("\n")}`
        : "";

      new Notice(`正在精修「${file.basename}」...這可能需要一些時間。`);

      const userPromptContext = `【原始標題】：${file.basename}\n\n【筆記內文】：\n${bodyContent}${existingTagsContext}${relatedContext}`;

      const rawResponse = await this.apiClient.prompt(
        REFINER_SYSTEM_PROMPT,
        userPromptContext,
        this.temperature
      );

      const parsed = parseJsonFromLLM<RefinerResult>(rawResponse);

      if (!parsed || !Array.isArray(parsed.highlights) || parsed.highlights.length === 0) {
        new Notice("大型語言模型（LLM）回傳的 JSON 結構非預期。請檢查主控台。");
        console.error("[NoteRefinerEngine] Invalid response:", rawResponse);
        return;
      }

      // --- Catalyst Questions Prompt Flow (Sequential Modal) ---
      const questions = parsed.catalystQuestions && parsed.catalystQuestions.length > 0
        ? parsed.catalystQuestions
        : ["如果你現在將此文章應用在你的情境，會遇到什麼挑戰？"];

      const catalyst = new ViewpointCatalyst(
        this.app,
        this.apiClient,
        this.temperature
      );

      // Prompt user with catalyst questions (blocks refinement flow until resolved)
      const userAnswer = await catalyst.promptUser(file.basename, parsed.highlights, questions);

      new Notice("🧠 正在判讀思考痕跡並決定拆解深度...");

      const phase2UserPrompt = `【筆記標題】：${file.basename}
【摘要與重點提取】：
${parsed.highlights.join("\n")}

【催化問題】：
${questions.map((q, idx) => `${idx + 1}. ${q}`).join("\n")}

【使用者的簡短回答】：
${userAnswer || "（使用者跳過了回答，未提供思考痕跡）"}`;

      const rawPhase2Response = await this.apiClient.prompt(
        EVALUATE_AND_REFLECT_SYSTEM_PROMPT,
        phase2UserPrompt,
        this.temperature
      );

      const parsedPhase2 = parseJsonFromLLM<Phase2Result>(rawPhase2Response) || {
        passed: false,
        atomicNotes: [],
        relatedLinks: [],
        lightweightLabel: "未通過思考痕跡判讀"
      };

      // 1. Create Atomic Notes if passed (with ontology-aware back-link to source)
      const atomicLinks: string[] = [];
      if (parsedPhase2 && parsedPhase2.passed && parsedPhase2.atomicNotes && Array.isArray(parsedPhase2.atomicNotes)) {
        for (const atomic of parsedPhase2.atomicNotes) {
          const fileName = this.sanitizeFileName(atomic.title);
          const link = await this.createAtomicNote(fileName, atomic, parsed.category, file.basename);
          if (link) {
            atomicLinks.push(link);
          }
        }
      }

      // Capture original quotes to preserve
      const originalQuotes = this.captureSection(originalContent, "原文關鍵句摘錄 (Original Quotes)");

      const defaultQuotes = `## 原文關鍵句摘錄 (Original Quotes)
> "[英文原句，逐字摘錄]"
> — [出處段落關鍵字]

> ""
> — [出處段落關鍵字]

> ""
> — [出處段落關鍵字]`;

      let finalQuotes = "";
      if (this.isQuotesEmptyOrPlaceholder(originalQuotes)) {
        if (parsed.originalQuotes && parsed.originalQuotes.length > 0) {
          finalQuotes = this.formatOriginalQuotes(parsed.originalQuotes);
        } else {
          finalQuotes = defaultQuotes;
        }
      } else {
        finalQuotes = originalQuotes;
      }

      // 2. Build newly refined content
      const refinedBody = this.buildRefinedContent(parsed, parsedPhase2, atomicLinks, finalQuotes, questions, userAnswer);

      // ── Ontology Re-injection: restore any missing wikilinks & tags ──
      const ontologyRestoredBody = this.restoreOntology(refinedBody, ontology);

      // 3. Update the original note (replace content, update frontmatter)
      let finalCategory = parsed.category;
      if (!PILLARS.includes(finalCategory)) {
        finalCategory = "00_收件箱";
      }

      const tagsToAdd = [...(parsed.tags || [])];
      let shouldMove = false;
      let destinationFolder = "";

      const parentPath = file.parent?.path || "";
      const isInInbox = (parentPath === "00_Inbox" || parentPath === "00_收件箱");

      if (parsed.confidence < 0.7) {
        tagsToAdd.push("#AI-Uncertain");
      }

      if (isInInbox) {
        const currentFileContent = await this.app.vault.read(file);
        const cache = this.app.metadataCache.getFileCache(file);
        const frontmatter = cache?.frontmatter || {};
        const tags = this.getFileTags(file);

        if (this.hasExternalSourceOrUrl(currentFileContent, frontmatter, tags)) {
          destinationFolder = "01_Sources";
        } else {
          destinationFolder = "88_Archive";
        }
        shouldMove = true;
      }
      
      // Update frontmatter — merge ontology-preserved tags + new LLM tags
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        // Preserve all original frontmatter keys that the LLM doesn't manage
        for (const [key, value] of Object.entries(ontology.preservedFrontmatter)) {
          if (!(key in frontmatter)) {
            frontmatter[key] = value;
          }
        }

        frontmatter["category"] = shouldMove ? destinationFolder : finalCategory;
        const existingTags: string[] = Array.isArray(frontmatter["tags"]) ? frontmatter["tags"] : [];
        const allTags = [...existingTags, ...tagsToAdd, ...ontology.frontmatterTags];
        frontmatter["tags"] = Array.from(new Set(allTags));
        
        // Add a flag that this was refined
        frontmatter["refined"] = true;

        if (parsedPhase2) {
          frontmatter["reflection_passed"] = parsedPhase2.passed;
          if (parsedPhase2.lightweightLabel) {
            frontmatter["lightweight_label"] = parsedPhase2.lightweightLabel;
          }
        }
      });

      // We read again to get the file with updated frontmatter, then replace its body
      const contentWithNewFrontmatter = await this.app.vault.read(file);
      const frontmatterMatch = contentWithNewFrontmatter.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
      const frontmatterStr = frontmatterMatch ? frontmatterMatch[0] : "";
      
      const newFullContent = frontmatterStr + ontologyRestoredBody;
      await this.app.vault.modify(file, newFullContent);

      // --- Smart Renaming (if suggestedTitle is valid and differs from existing)
      const newBaseName = parsed.suggestedTitle 
        ? this.sanitizeFileName(parsed.suggestedTitle).slice(0, 50) 
        : file.basename;
      
      let finalName = file.basename;
      if (newBaseName && newBaseName !== file.basename) {
         // Attempt to rename the file. Ensure no collisions.
         const parentDirPath = file.parent?.path || "";
         const newPath = normalizePath(`${parentDirPath}/${newBaseName}.md`);
         if (!this.app.vault.getAbstractFileByPath(newPath)) {
            await this.app.vault.rename(file, newPath);
            finalName = newBaseName;
         }
      }

      // 4. Move file if needed
      if (shouldMove) {
        await this.moveFileToCategory(file, destinationFolder);
        new Notice(`精修完成並已重新命名為「${finalName}」，移動到 ${destinationFolder}`);
      } else {
        new Notice(`精修完成（${finalName}）。`);
      }

      // ================================================================
      // SECOND SELF — Post-Refinement Reasoning Pipeline
      // Feature 1 → Feature 2 → Feature 3 (sequential)
      // ================================================================

      // After rename and/or move, `file` may point to a stale path.
      // Re-fetch the live TFile from vault to ensure metadataCache is valid.
      const parentDirAfterMove = file.parent?.path || "";
      const movedCategory = shouldMove ? destinationFolder : parentDirAfterMove;
      const freshPath = normalizePath(`${movedCategory}/${finalName}.md`);
      const freshFile = (this.app.vault.getAbstractFileByPath(freshPath) as TFile) ?? file;

      // Feature 2: Contradiction Radar (background, non-blocking)
      try {
        const radar = new ContradictionRadar(
          this.app,
          this.apiClient,
          this.temperature,
          this.secondSelfFolder,
          this.identityFileName
        );
        await radar.scan(freshFile);
      } catch (err) {
        console.error("[NoteRefinerEngine] Contradiction Radar error:", err);
      }

      // Feature 3: Core Question Anchor (background, non-blocking)
      try {
        const anchor = new CoreQuestionAnchor(
          this.app,
          this.apiClient,
          this.temperature,
          this.secondSelfFolder,
          this.identityFileName
        );
        await anchor.anchor(freshFile);
      } catch (err) {
        console.error("[NoteRefinerEngine] Core Question Anchor error:", err);
      }

    } catch (err) {
      console.error("[NoteRefinerEngine] Error processing file:", err);
      new Notice(`精修失敗：${(err as Error).message}`);
    }
  }

  private buildRefinedContent(
    parsedPhase1: RefinerResult,
    parsedPhase2: Phase2Result | null,
    atomicLinks: string[],
    originalQuotesContent: string,
    questions: string[],
    userAnswer: string | null
  ): string {
    const parts: string[] = [];

    // 1. Keywords Glossary
    if (parsedPhase1.keywords && Array.isArray(parsedPhase1.keywords) && parsedPhase1.keywords.length > 0) {
      parts.push(`> [!info] 關鍵詞彙對照表（Keywords 英文至繁體中文）`);
      for (const kw of parsedPhase1.keywords) {
        parts.push(`> - **${kw.en}**: ${kw.zh}`);
      }
      parts.push(``);
    }

    // 2. Summary
    parts.push(`## 摘要`);
    if (parsedPhase1.highlights && parsedPhase1.highlights.length > 0) {
      parts.push(parsedPhase1.highlights[0]);
      parts.push(``);
    } else {
      parts.push(`*（無摘要）*`);
      parts.push(``);
    }

    // 3. Highlights
    parts.push(`## 重點提取`);
    if (parsedPhase1.highlights && parsedPhase1.highlights.length > 1) {
      const bullets = parsedPhase1.highlights.slice(1);
      for (const hl of bullets) {
        const cleaned = hl.replace(/^[-*]\s+/, "").trim();
        if (cleaned) {
          parts.push(`- ${cleaned}`);
        }
      }
      parts.push(``);
    } else {
      parts.push(`*（未發現特定重點）*`);
      parts.push(``);
    }

    // 4. Original Quotes Section (bridge between highlights and reflection)
    parts.push(originalQuotesContent.trim());
    parts.push(``);

    // 5. Reflection Section
    parts.push(`## 反思 (Reflection)`);
    parts.push(``);
    if (questions && questions.length > 0) {
      parts.push(`**催化問題：**`);
      for (const q of questions) {
        parts.push(`- ${q}`);
      }
      parts.push(``);
    }

    parts.push(`**English (2-3 sentences, imperfect is fine, AI cannot ghostwrite):**`);
    parts.push(`[使用者手動填寫，必須寫在中文回答之前]`);
    parts.push(``);

    parts.push(`**中文簡短回答：**`);
    parts.push(userAnswer ? userAnswer.trim() : `[使用者手動填寫，緊接英文延伸即可，不需重新完整組織一次邏輯；AI不可在此欄位後方另加詮釋、讚美或重寫使用者的回答]`);
    parts.push(``);

    // 6. If passed, add Atomic Links and Related Links
    if (parsedPhase2 && parsedPhase2.passed) {
      if (atomicLinks.length > 0) {
        parts.push(`## 原子化概念筆記`);
        for (const link of atomicLinks) {
          parts.push(`- ${link}`);
        }
        parts.push(``);
      }

      if (parsedPhase2.relatedLinks && parsedPhase2.relatedLinks.length > 0) {
        const validLinks = parsedPhase2.relatedLinks.filter(
          link => link.noteName && link.reason && link.reason.trim()
        );
        if (validLinks.length > 0) {
          parts.push(`## 相關筆記`);
          for (const link of validLinks) {
            parts.push(`- [[${link.noteName}]]（理由：${link.reason.trim()}）`);
          }
          parts.push(``);
        }
      }
    } else if (parsedPhase2 && parsedPhase2.lightweightLabel) {
      // If failed, add lightweight label
      parts.push(`## 輕量標籤`);
      parts.push(`> ${parsedPhase2.lightweightLabel}`);
      parts.push(``);
    }

    const timestamp = new Date().toISOString().split("T")[0];
    parts.push(`%% AI_Refined_at: ${timestamp} %%`);

    return parts.join("\n");
  }

  /**
   * Create an atomic note with an ontology-aware back-link to its source note,
   * preserving the knowledge graph's bidirectional connectivity.
   */
  private async createAtomicNote(
    fileName: string, 
    data: { content: string; tags: string[] },
    category: string,
    sourceName?: string
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
        ? `tags:\n  - ${data.tags.map(t => t.replace(/^#/, "")).join("\n  - ")}`
        : "tags: []";

      // Ontology: maintain bidirectional link back to source note
      const sourceLink = sourceName ? `來源筆記：[[${sourceName}]]\n\n` : "";

      const fullContent = `---
type: atomic-note
category: ${finalCategory}
${tagsStr}
created: ${timestamp}
---
${sourceLink}
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

  // ========================================================================
  // Ontology Preservation
  // ========================================================================

  /**
   * Capture the semantic ontology of a note before LLM rewriting.
   * This includes wikilinks, inline tags, and frontmatter properties.
   */
  private captureOntology(content: string): OntologySnapshot {
    // Extract wikilinks: [[Target]] or [[Target|Alias]]
    const wikilinkRegex = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
    const wikilinks: string[] = [];
    let m;
    while ((m = wikilinkRegex.exec(content)) !== null) {
      wikilinks.push(m[1].trim());
    }

    // Extract inline #tags from body (not frontmatter)
    const body = this.stripFrontmatter(content);
    const tagRegex = /(?:^|\s)#([\w\-\/]+)/g;
    const inlineTags: string[] = [];
    while ((m = tagRegex.exec(body)) !== null) {
      inlineTags.push(m[1]);
    }

    // Extract @handles: (e.g. @username)
    const handleRegex = /(?:^|\s)@([a-zA-Z0-9_\-\.]+)/g;
    const handles: string[] = [];
    while ((m = handleRegex.exec(body)) !== null) {
      handles.push(m[0].trim());
    }

    // Extract markdown/Obsidian images: (e.g. ![[image.png]] or ![alt](url))
    const images: string[] = [];
    const mdImageRegex = /!\[([^\]]*)\]\(([^\)]+)\)/g;
    while ((m = mdImageRegex.exec(body)) !== null) {
      images.push(m[0].trim());
    }
    const obsidianImageRegex = /!\[\[([^\]]+)\]\]/g;
    while ((m = obsidianImageRegex.exec(body)) !== null) {
      images.push(m[0].trim());
    }

    // Extract markdown external links: (e.g. [text](url))
    const externalLinks: string[] = [];
    const mdLinkRegex = /(?<!!)\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g;
    while ((m = mdLinkRegex.exec(body)) !== null) {
      externalLinks.push(m[0].trim());
    }

    // Extract raw URLs (not inside markdown links/images):
    const rawUrlRegex = /(?<!\()https?:\/\/[^\s\)]+(?!\))/g;
    while ((m = rawUrlRegex.exec(body)) !== null) {
      const url = m[0].trim();
      if (!externalLinks.some(link => link.includes(url)) && !images.some(img => img.includes(url))) {
        externalLinks.push(url);
      }
    }

    // Extract frontmatter tags and all preserved properties
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    const frontmatterTags: string[] = [];
    const preservedFrontmatter: Record<string, unknown> = {};

    if (fmMatch) {
      const fmBlock = fmMatch[1];
      // Simple YAML key extraction for preservation
      const lines = fmBlock.split("\n");
      let currentKey = "";
      for (const line of lines) {
        const keyMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
        if (keyMatch) {
          currentKey = keyMatch[1];
          const value = keyMatch[2].trim();
          if (value && !value.startsWith("[") && value !== "") {
            preservedFrontmatter[currentKey] = value;
          }
        }
      }

      // Extract frontmatter tags array
      const tagsMatch = fmBlock.match(/tags:\s*\n((?:\s+-\s+.+\n?)*)/i);
      if (tagsMatch) {
        const tagLines = tagsMatch[1].split("\n");
        for (const tl of tagLines) {
          const t = tl.replace(/^\s*-\s*/, "").replace(/^#/, "").trim();
          if (t) frontmatterTags.push(t);
        }
      } else {
        // Inline tags format: tags: [tag1, tag2]
        const inlineTagsMatch = fmBlock.match(/tags:\s*\[([^\]]*)\]/i);
        if (inlineTagsMatch) {
          const parts = inlineTagsMatch[1].split(",");
          for (const p of parts) {
            const t = p.replace(/["'#]/g, "").trim();
            if (t) frontmatterTags.push(t);
          }
        }
      }
    }

    return {
      wikilinks: Array.from(new Set(wikilinks)),
      inlineTags: Array.from(new Set(inlineTags)),
      frontmatterTags: Array.from(new Set(frontmatterTags)),
      preservedFrontmatter,
      handles: Array.from(new Set(handles)),
      externalLinks: Array.from(new Set(externalLinks)),
      images: Array.from(new Set(images)),
    };
  }

  /**
   * Re-inject any wikilinks, tags, @handles, external links, and images that existed in the original
   * note but are absent from the LLM-rewritten body.
   */
  private restoreOntology(refinedBody: string, ontology: OntologySnapshot): string {
    // Find missing elements
    const missingLinks: string[] = [];
    for (const link of ontology.wikilinks) {
      if (!refinedBody.includes(`[[${link}`)) {
        missingLinks.push(link);
      }
    }

    const missingTags: string[] = [];
    for (const tag of ontology.inlineTags) {
      if (!refinedBody.includes(`#${tag}`)) {
        missingTags.push(tag);
      }
    }

    const missingHandles: string[] = [];
    for (const handle of ontology.handles) {
      if (!refinedBody.includes(handle)) {
        missingHandles.push(handle);
      }
    }

    const missingExtLinks: string[] = [];
    for (const link of ontology.externalLinks) {
      if (!refinedBody.includes(link)) {
        missingExtLinks.push(link);
      }
    }

    const missingImages: string[] = [];
    for (const img of ontology.images) {
      if (!refinedBody.includes(img)) {
        missingImages.push(img);
      }
    }

    const hasMissingOntology = 
      missingLinks.length > 0 || 
      missingTags.length > 0 || 
      missingHandles.length > 0 || 
      missingExtLinks.length > 0 || 
      missingImages.length > 0;

    // If nothing is missing, return as-is
    if (!hasMissingOntology) {
      return refinedBody;
    }

    // Build an "Ontology Preserved" section
    const parts: string[] = [refinedBody];
    parts.push("");
    parts.push("## 本體論保留區（Preserved Ontology）");
    parts.push("> 以下連結與標籤來自原始筆記，由系統自動保留以維護知識圖譜完整性。");
    parts.push("");

    const allMissingLinks: string[] = [];
    for (const link of missingLinks) {
      allMissingLinks.push(`- [[${link}]]`);
    }
    for (const handle of missingHandles) {
      allMissingLinks.push(`- ${handle}`);
    }
    for (const link of missingExtLinks) {
      allMissingLinks.push(`- ${link}`);
    }
    for (const img of missingImages) {
      allMissingLinks.push(`- ${img}`);
    }

    if (allMissingLinks.length > 0) {
      parts.push("**保留的雙向連結（Preserved Wikilinks）：**");
      for (const item of allMissingLinks) {
        parts.push(item);
      }
      parts.push("");
    }

    if (missingTags.length > 0) {
      parts.push("**保留的標籤（Preserved Tags）：**");
      parts.push(missingTags.map(t => `#${t}`).join(" "));
      parts.push("");
    }

    return parts.join("\n");
  }

  private getFileTags(file: TFile): string[] {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return [];
    
    const tags: string[] = [];
    
    // Frontmatter tags
    if (cache.frontmatter) {
      const fmTags = cache.frontmatter.tags || cache.frontmatter.tag;
      if (Array.isArray(fmTags)) {
        for (const t of fmTags) {
          if (typeof t === "string") {
            tags.push(t.replace(/^#/, "").trim());
          }
        }
      } else if (typeof fmTags === "string") {
        const parts = fmTags.split(/[\s,]+/).map(p => p.replace(/[\[\]"']|#/g, "").trim());
        tags.push(...parts.filter(Boolean));
      }
    }
    
    // Inline tags
    if (cache.tags) {
      for (const t of cache.tags) {
        tags.push(t.tag.replace(/^#/, "").trim());
      }
    }
    
    return Array.from(new Set(tags));
  }

  private findRelatedNotes(
    currentFile: TFile, 
    tags: string[], 
    keywords: { en: string; zh: string }[],
    suggestedTitle: string,
    existingLinks: Set<string>,
    limit: number = 5
  ): string[] {
    const allFiles = this.app.vault.getMarkdownFiles();
    const candidates: { file: TFile; score: number }[] = [];

    const cleanTags = tags.map(t => t.replace(/^#/, "").trim().toLowerCase());
    const keywordSet = new Set(
      keywords.flatMap(kw => [kw.en.toLowerCase(), kw.zh.toLowerCase()]).filter(Boolean)
    );
    const titleLower = suggestedTitle.toLowerCase();

    for (const f of allFiles) {
      if (f.path === currentFile.path) continue;
      // Do not suggest files that are already linked
      if (existingLinks.has(f.basename)) continue;
      // Exclude special utility or system files
      if (f.basename === "plan" || f.basename === "draft" || f.basename.includes("Atomic Note")) continue;

      let score = 0;
      
      // Tag-based relation
      const fTags = this.getFileTags(f).map(t => t.toLowerCase());
      for (const t of fTags) {
        if (cleanTags.includes(t)) {
          score += 10;
        }
      }

      // Keyword-based relation
      const baseLower = f.basename.toLowerCase();
      for (const kw of keywordSet) {
        if (baseLower === kw) {
          score += 20;
        } else if (baseLower.includes(kw) || kw.includes(baseLower)) {
          if (baseLower.length >= 2 && kw.length >= 2) {
            score += 5;
          }
        }
      }

      // Title relation
      if (titleLower.includes(baseLower) || baseLower.includes(titleLower)) {
        if (baseLower.length >= 3) {
          score += 5;
        }
      }

      if (score > 0) {
        candidates.push({ file: f, score });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, limit).map(c => c.file.basename);
  }

  private extractWikilinks(text: string): Set<string> {
    const wikilinkRegex = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
    const links: Set<string> = new Set();
    let m;
    while ((m = wikilinkRegex.exec(text)) !== null) {
      links.add(m[1].trim());
    }
    return links;
  }

  private hasExternalSourceOrUrl(content: string, frontmatter: any, tags: string[]): boolean {
    if (frontmatter) {
      if (frontmatter.type === "reference") return true;
      if (frontmatter.source && typeof frontmatter.source === "string" && /https?:\/\/[^\s\)]+/i.test(frontmatter.source)) return true;
    }
    const externalKeywords = ["web-clippings", "clippings", "reference", "source", "external-source", "clipping", "article", "paper", "web", "news"];
    for (const tag of tags) {
      const cleanTag = tag.replace(/^#/, "").trim().toLowerCase();
      if (externalKeywords.some(kw => cleanTag.includes(kw))) {
        return true;
      }
    }
    const body = this.stripFrontmatter(content);
    if (/https?:\/\/[^\s\)]+/i.test(body)) {
      return true;
    }
    return false;
  }

  private isQuotesEmptyOrPlaceholder(quotesContent: string): boolean {
    if (!quotesContent || quotesContent.trim() === "") {
      return true;
    }
    const cleaned = quotesContent.replace(/<!--[\s\S]*?-->/g, "").trim();
    const lines = cleaned.split("\n");
    let hasActualQuote = false;
    for (const line of lines) {
      if (line.startsWith(">")) {
        const quoteText = line.substring(1).replace(/["'\[\]\s]/g, "");
        if (quoteText.length > 0 && 
            !quoteText.includes("英文原句") && 
            !quoteText.includes("逐字摘錄")) {
          hasActualQuote = true;
          break;
        }
      }
    }
    return !hasActualQuote;
  }

  private formatOriginalQuotes(quotes: { quote: string; source: string }[]): string {
    const parts: string[] = [
      `## 原文關鍵句摘錄 (Original Quotes)`,
      ""
    ];
    for (const q of quotes) {
      if (q.quote && q.quote.trim()) {
        parts.push(`> "${q.quote.trim()}"`);
        parts.push(`> — ${q.source ? q.source.trim() : ""}`);
        parts.push("");
      }
    }
    return parts.join("\n");
  }

  private checkReflectionFilled(reflectionContent: string): { englishFilled: boolean; chineseFilled: boolean; englishSentencesCount: number } {
    const englishRegex = /\*\*English \(2-3 sentences, imperfect is fine\):\*\*\s*([\s\S]*?)(?=\*\*中文完整反思：\*\*|$)/i;
    const chineseRegex = /\*\*中文完整反思：\*\*\s*([\s\S]*?)(?=\n##|<!--|\%\%|$)/i;

    const englishMatch = reflectionContent.match(englishRegex);
    const chineseMatch = reflectionContent.match(chineseRegex);

    let englishText = englishMatch ? englishMatch[1] : "";
    let chineseText = chineseMatch ? chineseMatch[1] : "";

    // Strip HTML comments, placeholder text, and whitespace
    englishText = englishText.replace(/<!--[\s\S]*?-->/g, "").trim();
    chineseText = chineseText.replace(/<!--[\s\S]*?-->/g, "").trim();

    englishText = englishText.replace(/\[使用者手動輸入.*?\]/g, "").trim();
    chineseText = chineseText.replace(/\[使用者手動輸入.*?\]/g, "").trim();

    const englishFilled = englishText.length > 0;
    const chineseFilled = chineseText.length > 0;

    // Count English sentences roughly
    const sentences = englishText.split(/[.!?]+(?:\s+|$)/).filter(s => s.trim().length > 0);
    const englishSentencesCount = sentences.length;

    return { englishFilled, chineseFilled, englishSentencesCount };
  }

  private captureSection(content: string, heading: string): string {
    const escapedHeading = heading.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`## ${escapedHeading}\\n([\\s\\S]*?)(?=\\n## |$)`);
    const match = content.match(regex);
    if (match) {
      return `## ${heading}\n${match[1].trim()}\n`;
    }
    return "";
  }
}
