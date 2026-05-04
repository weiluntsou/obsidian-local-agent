import { App, TFile, Notice, normalizePath, TAbstractFile } from "obsidian";
import { LocalLLMClient, parseJsonFromLLM } from "./api";

const CLEANER_SYSTEM_PROMPT = `你是一位「知識清掃與自我修復（Self-Healing/CPR）」引擎。你的任務是維護知識庫的完整性與流動性。
使用者提交通過右鍵觸發清掃的一篇待處理筆記。請執行以下模組：

1. 壓縮（Compress）：對過去陳舊的內容、冗長草稿或會議記錄進行「去碎片化」。剃除瑣碎廢話，只保留高濃縮度的原子摘要與核心邏輯，以便為日後檢索釋放空間。若原內容已經極度精簡，可不壓縮直接沿用。
2. 恢復（Resume）：在最頂端撰寫一段精煉的「Context Summary（上下文概覽）」，讓未來的使用者在幾個月後看到這篇筆記時能一秒鐘喚醒當時的思考路徑。
3. 語義橋接（Semantic Bridge）：根據提供的「現有知識庫標題清單」，透過語義聯想為這篇筆記推薦 3~5 個可能高度相關。
4. 狀態評估：若發現該筆記已然失去時效性或核心價值極低，可將狀態（actionStatus）設為 "archived"。若順利提煉成精華，則設為 "compressed" 或 "refined"。

因為你需要嚴格遵守變更安全限制，請絕對只輸出一個合法的 JSON 物件，不可以包含任何 markdown 語言代碼塊或其他閒聊，格式如下：
{
  "contextSummary": "一段簡潔的概覽...",
  "compressedBody": "經過 CPR 壓縮或保留精華後的核心正文（Markdown 格式，請小心不要破壞原有代碼或結構）...",
  "suggestedLinks": ["相關的筆記名A", "相關的筆記名B"],
  "actionStatus": "compressed" // 或 refined, archived
}

如果發現原筆記為空，請在 "compressedBody" 標記查無內容。`;

interface CleanerResponse {
  contextSummary: string;
  compressedBody: string;
  suggestedLinks: string[];
  actionStatus: string;
}

export class CleanerEngine {
  constructor(
    private app: App,
    private apiClient: LocalLLMClient,
    private temperature: number
  ) {}

  public async cleanFile(file: TFile): Promise<void> {
    new Notice(`正在啟動「${file.basename}」的 CPR 清掃作業...`);
    try {
      const originalContent = await this.app.vault.read(file);
      

      // ── 第一維度：知識完整性驗證 Integrity Check ──
      const isOrphan = this.checkIfOrphan(file);
      const brokenLinks = this.getBrokenLinks(file);
      
      const fmRegex = /^---\s*\n[\s\S]*?\n---\s*\n?/;
      const frontmatterStr = (originalContent.match(fmRegex) || [""])[0];
      const bodyContent = originalContent.replace(fmRegex, "").trim();

      if (bodyContent.length === 0) {
        new Notice("這篇筆記沒有內容可供清掃與去碎片化！");
        return;
      }

      // ── 第三維度：語義橋接與掃描 Semantic Bridge Context ──
      // 蒐集現有的 Vault 標題以供引擎掃描與比對
      const allFiles = this.app.vault.getMarkdownFiles()
        .filter(f => f.path !== file.path)
        .map(f => f.basename);
      
      // Token budget limits: randomly sample up to ~300 notes if vault is huge, prioritizing recency
      const recentFiles = this.app.vault.getMarkdownFiles()
         .filter(f => f.path !== file.path)
         .sort((a, b) => b.stat.mtime - a.stat.mtime)
         .slice(0, 300)
         .map(f => f.basename);

      const userPrompt = `### 目前筆記名稱：${file.basename}
### 孤島診斷（Orphan Status）：${isOrphan ? "是（沒有任何反向連結或出網連結）" : "否"}
### 發現已斷開的失效連結（Broken Links）：${brokenLinks.length > 0 ? brokenLinks.join(", ") : "無"}

### 知識庫標題候選清單（供語義橋接挑選）：
${recentFiles.join(" | ")}

### 原始內文：
${bodyContent}
`;
      
      // 呼叫 LLM 進行壓縮與橋接
      const rawResponse = await this.apiClient.prompt(
        CLEANER_SYSTEM_PROMPT,
        userPrompt,
        this.temperature
      );

      const parsed = parseJsonFromLLM<CleanerResponse>(rawResponse);
      if (!parsed || typeof parsed.compressedBody !== "string") {
        new Notice("清掃引擎回傳了錯誤的 JSON 結構，無法完成。");
        console.error("[CleanerEngine] Failed to parse JSON:", rawResponse);
        return;
      }

      // 組裝新的內文內容
      let newBody = "";
      
      // 2. 恢復 - Resume
      if (parsed.contextSummary) {
        newBody += `> [!abstract] CPR Resume (上下文恢復)\n> ${parsed.contextSummary.replace(/\\n/g, "\\n> ")}\n\n`;
      }
      
      // 1. 壓縮 - Compress
      newBody += parsed.compressedBody + "\n\n---";

      // 3. 語義橋接 - Semantic Bridge
      if (parsed.suggestedLinks && Array.isArray(parsed.suggestedLinks) && parsed.suggestedLinks.length > 0) {
        newBody += `\n\n%% AI_Suggestions %%\n> 💡 **語義橋接推薦 (Semantic Bridge)**：偵測到此筆記主題與你的現有知識庫存在潛在連結，建議您檢閱：\n`;
        parsed.suggestedLinks.forEach(link => {
          newBody += `> - [[${link}]]\n`;
        });
      }

      const finalContent = frontmatterStr + newBody;

      // 儲存修改
      await this.app.vault.modify(file, finalContent);

      // 更新 YAML (Preserve 歸檔機制)
      const now = new Date().toISOString();
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm["last-cleaned"] = now;
        fm["cpr_status"] = parsed.actionStatus || "compressed";
        
        // 保留可能有的原本 frontmatter
        if (isOrphan && !fm["tags"]) {
            fm["tags"] = ["#AI-Cleaned-Orphan"];
        }
      });

      new Notice(`清掃與去碎片化完成！（狀態：${parsed.actionStatus}）`);

      // 4. Preserve 五大柱歸檔邏輯 (如果被歸檔且含有 #Done 或 archived)
      if (parsed.actionStatus === "archived") {
          const contentAfterFm = await this.app.vault.read(file);
          if (contentAfterFm.includes("#Done") && file.parent?.path === "00_Inbox") {
             // Extract category if it exists to move it out of inbox
             let matchCat = await this.getCategory(file);
             if (matchCat && matchCat !== "00_Inbox") {
                await this.moveFileToCategory(file, matchCat);
                new Notice(`已將過時內容自動遷移並歸檔至：${matchCat}`);
             } else {
                await this.moveFileToCategory(file, "99_未分類");
                new Notice(`已將內容自動歸檔至 99_未分類`);
             }
          }
      }

    } catch (err) {
      console.error("[CleanerEngine] Error:", err);
      new Notice(`清掃過程發生錯誤: ${(err as Error).message}`);
    }
  }

  // --- Helpers ---

  private async getCategory(file: TFile): Promise<string | null> {
      let cat: string | null = null;
      await this.app.fileManager.processFrontMatter(file, fm => {
          if (fm["category"]) cat = fm["category"];
      });
      return cat;
  }

  private async moveFileToCategory(file: TFile, category: string): Promise<void> {
    const destFolder = normalizePath(category);
    const abstractFolder = this.app.vault.getAbstractFileByPath(destFolder);
    if (!abstractFolder) {
      await this.app.vault.createFolder(destFolder);
    }
    const newPath = normalizePath(`${category}/${file.name}`);
    if (!this.app.vault.getAbstractFileByPath(newPath)) {
        await this.app.vault.rename(file, newPath);
    }
  }

  private checkIfOrphan(file: TFile): boolean {
    const resolved = this.app.metadataCache.resolvedLinks;
    const outLinksCount = Object.keys(resolved[file.path] || {}).length;

    let inLinksCount = 0;
    for (const sourcePath in resolved) {
        if (resolved[sourcePath][file.path]) {
            inLinksCount++;
        }
    }
    // Return true if there are absolutely no incoming and no outgoing markdown file links
    return outLinksCount === 0 && inLinksCount === 0;
  }

  private getBrokenLinks(file: TFile): string[] {
    const unresolved = this.app.metadataCache.unresolvedLinks[file.path] || {};
    return Object.keys(unresolved);
  }


}
