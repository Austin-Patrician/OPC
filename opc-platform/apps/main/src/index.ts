import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, session, shell } from 'electron';
import { ChatService } from './chat/chatService';
import { agentsFromOrg, chatDepartmentsFromOrg, ensureFirstCompany } from './seed/firstCompany';
import { consolidateConversation } from './memory/consolidation';
import { MemoryService } from './memory/memoryService';
import { OrgFactService } from './memory/orgFactService';
import { resetCompany } from './seed/resetCompany';
import { openCompanyDatabase } from './data/companyDatabase';
import { registerIpc } from './ipc/register';
import { AuthService } from './models/authService';
import { FileCredentialStore } from './models/credentialStore';
import { ImageService } from './models/imageService';
import { ModelConfigService } from './models/modelConfigService';
import type { Agent, SubtaskDraft } from '@opc/shared/domain';
import { MarketService } from './market/marketService';
import { OrgService } from './org/orgService';
import { initAppPaths, appPaths } from './paths';
import { WorkService } from './work/workService';
import { DEMO_TASK } from './work/acceptanceTemplate';

const isDev = !app.isPackaged;

/** Compile-time constant injected by electron-vite: `out/main`. */
const mainDir = __dirname;

const isSelfTest = process.argv.includes("--self-test");
/** `OPC_SMOKE=1`: boot the real window, exercise preload + IPC, print a report, exit. */
const isSmoke = process.env.OPC_SMOKE === "1";
/** `OPC_WORK_PROBE=1`: run the Phase 0 loop headlessly and print evidence. */
const isWorkProbe = process.env.OPC_WORK_PROBE === "1";
/** `OPC_BUDGET_PROBE=1`: prove reserve → refuse → settle → stop. */
const isBudgetProbe = process.env.OPC_BUDGET_PROBE === "1";
/** `OPC_MODEL_PROBE=1`: import the local pi provider config and run one task with the model brain. */
const isModelProbe = process.env.OPC_MODEL_PROBE === "1";
/** `OPC_DECOMPOSE_PROBE=1`: hierarchy, three hard constraints, children run. */
const isDecomposeProbe = process.env.OPC_DECOMPOSE_PROBE === "1";
/** `OPC_FACT_PROBE=1`: company facts are versioned and reach the employee's prompt. */
const isFactProbe = process.env.OPC_FACT_PROBE === '1';
/** `OPC_ARCHIVE_PROBE=1`: idle conversation → archived → consolidated once. */
const isArchiveProbe = process.env.OPC_ARCHIVE_PROBE === '1';
/** `OPC_CONSOLIDATE_PROBE=1`: a settled conversation becomes long-term memory. */
const isConsolidateProbe = process.env.OPC_CONSOLIDATE_PROBE === '1';
/** `OPC_MEMORY_PROBE=1`: write → recall into the prompt → recall strengthens it. */
const isMemoryProbe = process.env.OPC_MEMORY_PROBE === '1';
/** `OPC_CHAT_PERSIST_PROBE=1`: messages survive a ChatService restart. */
const isChatPersistProbe = process.env.OPC_CHAT_PERSIST_PROBE === '1';
/** `OPC_MARKET_SEED=1`: leave one imported candidate in the market (for UI checks). */
const isMarketSeed = process.env.OPC_MARKET_SEED === '1';
/** `OPC_RESET_COMPANY=1`: wipe business rows, re-seed the clean two-department company. */
const isResetCompany = process.env.OPC_RESET_COMPANY === '1';
/** `OPC_FIRST_RUN_PROBE=1`: a temp userData dir → prove what a fresh install contains. */
const isFirstRunProbe = process.env.OPC_FIRST_RUN_PROBE === '1';
/** `OPC_CHAT_PROBE=1`: 1v1 + department group are created once and reused. */
const isChatProbe = process.env.OPC_CHAT_PROBE === "1";
/** `OPC_REVIEW_PROBE=1`: system pass → manager verdict.json → original accepted. */
const isReviewProbe = process.env.OPC_REVIEW_PROBE === "1";
/** `OPC_MARKET_PROBE=1`: import an agent package, hire it, verify it becomes an employee. */
const isMarketProbe = process.env.OPC_MARKET_PROBE === "1";
/** `OPC_ORG_PROBE=1`: department → hire → dispatch → fire → dispatch refused. */
const isOrgProbe = process.env.OPC_ORG_PROBE === "1";
/** `OPC_IMAGE_LOOP_PROBE=1`: mock image endpoint → agent tool → image-200 acceptance. */
const isImageLoopProbe = process.env.OPC_IMAGE_LOOP_PROBE === "1";
/** `OPC_CRASH_PROBE=start|resume`: kill the app mid-run, then prove it resumes. */
const crashProbe = process.env.OPC_CRASH_PROBE;
let mainWindow: BrowserWindow | null = null;
let chat: ChatService | null = null;
let work: WorkService | null = null;
let disposeIpc: (() => void) | null = null;
function createMainWindow() {
	const window = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 1024,
		minHeight: 640,
		show: false,
		backgroundColor: "#dcdce0",
		title: "OPC Agent 工作台",
		...process.platform === "darwin" ? {
			titleBarStyle: "hiddenInset",
			trafficLightPosition: {
				x: 14,
				y: 15
			}
		} : process.platform === "win32" ? {
			titleBarStyle: "hidden",
			titleBarOverlay: {
				color: "#ebebec",
				symbolColor: "#4a4a4d",
				height: 42
			}
		} : { titleBarStyle: "default" },
		webPreferences: {
			preload: path.join(mainDir, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
			spellcheck: false
		}
	});
	window.once("ready-to-show", () => {
		if (!isSmoke) window.show();
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//.test(url)) shell.openExternal(url);
		return { action: "deny" };
	});
	window.webContents.on("will-navigate", (event, url) => {
		const devOrigin = process.env.ELECTRON_RENDERER_URL;
		if (!(devOrigin ? url.startsWith(devOrigin) : url.startsWith("file://"))) {
			event.preventDefault();
			if (/^https?:\/\//.test(url)) shell.openExternal(url);
		}
	});
	if (isSmoke) attachSmokeTest(window);
	if (isDev && process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL);
	else window.loadFile(path.join(mainDir, "../renderer/index.html"));
	return window;
}
/**
* End-to-end smoke test: proves that the window renders React, that the sandboxed
* preload injected `window.opc`, and that one IPC round-trip mutates the main-side
* service and streams a snapshot back.
*/
function attachSmokeTest(window: BrowserWindow) {
	window.webContents.once("did-finish-load", () => {
		(async () => {
			try {
				const result = await window.webContents.executeJavaScript(`(async () => {
          let before = await window.opc.chat.getSnapshot();
          // A fresh company has no conversations: open a real 1v1 first, exactly as
          // the boss would from the org chart.
          if (before.conversations.length === 0) {
            const orgTree = await window.opc.org.list();
            const firstMember = orgTree.flatMap((node) => node.members)[0];
            if (firstMember) await window.opc.chat.openDirect(firstMember.id);
            before = await window.opc.chat.getSnapshot();
          }
          const conversation = before.conversations[0];
          const nextSnapshot = new Promise((resolve) => {
            const off = window.opc.chat.onSnapshot((snapshot) => {
              const current = snapshot.conversations.find((c) => c.id === conversation.id);
              if (current && current.messages.length > conversation.messages.length) {
                off();
                resolve(current.messages.length);
              }
            });
            setTimeout(() => { off(); resolve(-1); }, 4000);
          });
          await window.opc.chat.sendMessage({ conversationId: conversation.id, text: 'smoke: 检查交付进度' });
          const afterCount = await nextSnapshot;
          // Phase 0 loop through the real bridge: create → run → accepted card in the UI.
          const created = await window.opc.work.createTask({
            title: '写一个 hello world HTTP 服务',
            brief: '用 Node 内置 http 模块实现：GET / 返回 ok。',
            deliverableSpec: 'server.js：node server.js 启动，GET / 返回 ok',
            assigneeId: conversation.primaryAgentId || conversation.memberIds[0],
            estTokens: 6000,
            acceptanceCommand: ['node', '{checks}/verify.mjs'],
          });
          if (!created.ok) throw new Error('创建任务被拒绝: ' + created.error.code);
          const task = created.task;
          await window.opc.work.runTask(task.id);

          const finishedTask = await new Promise((resolve) => {
            const off = window.opc.work.onTaskChanged((changed) => {
              if (
                changed.id === task.id &&
                (changed.status === 'accepted' || changed.status === 'review' || changed.status === 'rejected' || changed.status === 'failed')
              ) {
                off();
                resolve(changed);
              }
            });
            // A real model run with tools can exceed 20s in the packaged app.
            setTimeout(() => { off(); resolve(null); }, 90000);
          });

          const bossButtons = document.querySelectorAll('[data-testid="boss-approve"]').length;
          // Department dossier → rules block → write through IPC → row appears.
          localStorage.setItem('opc.org.view', 'tree');
          location.hash = '#/org';
          await new Promise((r) => setTimeout(r, 700));
          document.querySelector('[data-testid="org-view-board"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          await new Promise((r) => setTimeout(r, 400));
          document.querySelector('[data-testid="board-column"] [role="button"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          await new Promise((r) => setTimeout(r, 300));
          const deptRulesForm = Boolean(document.querySelector('[data-testid="dept-fact-subject"]'));
          const tree = await window.opc.org.list();
          const anyDepartment = tree[0];
          let deptRuleVisible = false;
          if (anyDepartment) {
            await window.opc.facts.write({
              scopeType: 'department',
              scopeId: anyDepartment.id,
              subject: 'smoke',
              object: '规则写入可见',
            });
            document.querySelector('[data-testid="org-view-tree"]')?.dispatchEvent(
              new MouseEvent('click', { bubbles: true }),
            );
            await new Promise((r) => setTimeout(r, 300));
            document.querySelector('[data-testid="org-card"]')?.dispatchEvent(
              new MouseEvent('click', { bubbles: true }),
            );
            await new Promise((r) => setTimeout(r, 500));
            deptRuleVisible = document.querySelectorAll('[data-testid="dept-fact-row"]').length > 0;
          }
          const firstConversation = (await window.opc.chat.getSnapshot()).conversations[0];
          let archivedToggle = false;
          let menuArchiveWorks = false;
          let menuRestoreWorks = false;
          if (firstConversation) {
            await window.opc.chat.archive(firstConversation.id);
            await new Promise((r) => setTimeout(r, 400));
            archivedToggle = Boolean(document.querySelector('[data-testid="archived-toggle"]'));
          }
          // Menu flow: restore from the archived row, then archive again from the menu.
          document.querySelector('[data-testid="archived-toggle"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          await new Promise((r) => setTimeout(r, 300));
          // Archived rows render last, so the last menu belongs to an archived row.
          const menus = [...document.querySelectorAll('[data-testid="session-menu"]')];
          menus[menus.length - 1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 200));
          document.querySelector('[data-testid="session-restore"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          await new Promise((r) => setTimeout(r, 400));
          menuRestoreWorks =
            (await window.opc.chat.getSnapshot()).conversations.every((item) => !item.archivedAt);
          document.querySelector('[data-testid="session-menu"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          await new Promise((r) => setTimeout(r, 200));
          document.querySelector('[data-testid="session-archive"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          await new Promise((r) => setTimeout(r, 400));
          menuArchiveWorks = (await window.opc.chat.getSnapshot()).conversations.some(
            (item) => item.archivedAt,
          );
          localStorage.setItem('opc.org.view', 'tree');
          location.hash = '#/org';
          await new Promise((r) => setTimeout(r, 800));
          document.querySelector('[data-testid="org-view-tree"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 500));
          const zoomLabel = () =>
            document.querySelector('[data-testid="canvas-zoom-in"]')?.previousElementSibling?.textContent ?? '';
          const zoomIn = document.querySelector('[data-testid="canvas-zoom-in"]');
          const zoomBefore = zoomLabel();
          zoomIn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 200));
          const zoomAfter = zoomLabel();
          const legend = document.querySelector('[data-testid="canvas-legend"]') !== null;
          const cardVisible = await (async () => {
            // The card may already exist: check the current snapshot before waiting.
            const current = await window.opc.chat.getSnapshot();
            if (current.conversations.some((c) => c.messages.some((m) => m.kind === 'task' && m.task && m.task.id === task.id))) {
              return true;
            }
            return new Promise((resolve) => {
            const off = window.opc.chat.onSnapshot((snapshot) => {
              const found = snapshot.conversations.some((c) =>
                c.messages.some((m) => m.kind === 'task' && m.task && m.task.id === task.id),
              );
              if (found) { off(); resolve(true); }
            });
            setTimeout(() => { off(); resolve(false); }, 10000);
            });
          })();

          // Budget refusal must reach the renderer as a structured result, not a crash.
          const budgets = await window.opc.work.listBudgets();
          const employeeBudget = budgets.find((b) => b.scope === 'employee');
          const refused = await window.opc.work.createTask({
            title: '预算拒绝用例',
            brief: '不应被执行',
            deliverableSpec: 'none',
            assigneeId: conversation.primaryAgentId || conversation.memberIds[0],
            estTokens: 999_999_999,
            acceptanceCommand: ['node', '{checks}/verify.mjs'],
          });

          // Settings → Models must actually render the provider list.
          location.hash = '#/settings';
          await new Promise((r) => setTimeout(r, 400));
          document.querySelector('[data-testid="settings-group-models"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 200));
          document.querySelector('[data-testid="settings-page-llm"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 700));
          const providerRows = document.querySelectorAll('[data-testid="provider-row"]').length;
          const providerIcons = document.querySelectorAll('img[src*="provider-icons"]').length;
          const llmTableScrollable = Boolean(
            document.querySelector('[data-testid="llm-model-table"]')?.classList.contains('overflow-y-auto'),
          );

          // The key row's Save button must stay horizontal.
          const saveButton = [...document.querySelectorAll('button')]
            .map((button) => ({ button, box: button.getBoundingClientRect() }))
            .find(({ button, box }) => button.textContent?.trim() === '保存' && box.height > 0);
          const saveBox = saveButton ? { w: Math.round(saveButton.box.width), h: Math.round(saveButton.box.height) } : null;

          // Image page: every model row shows its vendor's provider icon.
          document.querySelector('[data-testid="settings-page-image"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 600));
          const imageIcons = document.querySelectorAll('img[src*="provider-icons"]').length;
          const imageRows = document.querySelectorAll('[data-testid="image-model-row"]').length;
          const imageGenerateButton = Boolean(document.querySelector('[data-testid="image-generate"]'));
          const imageTableScrollable = Boolean(
            document.querySelector('[data-testid="image-model-row"]')?.closest('.overflow-y-auto'),
          );

          // Org chart is real data now, not a placeholder.
          location.hash = '#/org';
          await new Promise((r) => setTimeout(r, 600));
          // The view is persisted by the user: always start from the tree.
          document.querySelector('[data-testid="org-view-tree"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
          const orgMembers = document.querySelectorAll('[data-testid="org-member"]').length;
          const orgDepartments = document.querySelectorAll('[data-testid="org-department"]').length;
          const orgViews = document.querySelectorAll('[data-testid^="org-view-"]').length;
          const orgCanvas = Boolean(document.querySelector('[data-testid="org-canvas"]'));
          const orgCards = document.querySelectorAll('[data-testid="org-canvas"] [data-org-card]').length;
          document.querySelector('[data-testid="org-view-roster"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
          const rosterRows = document.querySelectorAll('[data-testid="org-member"]').length;
          document.querySelector('[data-testid="org-view-tree"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 400));
          const orgFilter = Boolean(document.querySelector('[data-testid="org-status-filter"]'));
          const orgTabs = document.querySelectorAll('[data-testid="tab-org"], [data-testid="tab-market"]').length;
          const panelBeforeClick = Boolean(document.querySelector('[data-testid="close-detail"]'));
          const deptCards = document.querySelectorAll('[data-testid="org-card"]');
          deptCards[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
          const panelAfterCardClick = Boolean(document.querySelector('[data-testid="close-detail"]'));
          document.querySelector('[data-testid="close-detail"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 200));
          const panelAfterClose = Boolean(document.querySelector('[data-testid="close-detail"]'));
          const directoryToggle = Boolean(document.querySelector('[data-testid="hide-directory"]'));
          document.querySelector('[data-testid="hide-directory"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 200));
          const showDirectory = Boolean(document.querySelector('[data-testid="show-directory"]'));
          const orgHasUnassigned = [...document.querySelectorAll('[data-testid="org-department"]')]
            .some((node) => node.textContent?.includes('未分配'));
          location.hash = '#/market';
          await new Promise((r) => setTimeout(r, 500));
          const marketRows = document.querySelectorAll('[data-testid="market-row"]').length;
          const importButton = Boolean(document.querySelector('[data-testid="import-package"]'));
          const marketHero = Boolean(document.querySelector('[data-testid="tab-market"]'));
          const marketEmpty = document.querySelectorAll('[data-testid="candidate-row"]').length;
          const marketPool = document.querySelectorAll('[data-testid="market-row"]').length;
          const expandBtn = document.querySelector('[data-testid="candidate-expand"]');
          const expandBefore = expandBtn?.getAttribute('aria-expanded') ?? null;
          expandBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
          const expandAfter =
            document.querySelector('[data-testid="candidate-expand"]')?.getAttribute('aria-expanded') ?? null;
          const expandToggles = expandBefore === 'false' && expandAfter === 'true';
          location.hash = '#/org';
          await new Promise((r) => setTimeout(r, 600));
          document.querySelector('[data-testid="custom-hire"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 400));
          const wizardOpen = Boolean(document.querySelector('[data-testid="hire-wizard"]'));
          const wizardSteps = document.querySelectorAll('[data-testid^="wizard-step-"]').length;
          document.querySelector('[data-testid="hire-wizard"] [aria-label]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 200));
          localStorage.setItem('opc.org.view', 'tree');
          location.hash = '#/org';
          await new Promise((r) => setTimeout(r, 600));
          document.querySelector('[data-testid="new-department"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
          const newDeptFields = [
            'new-dept-name',
            'new-dept-code',
            'new-dept-description',
            'new-dept-head',
          ].filter((id) => document.querySelector('[data-testid="' + id + '"]')).length;
          document.querySelector('[data-testid="hire-wizard"] [aria-label]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 200));
          const directoryColors = [...document.querySelectorAll('[data-testid="org-department"] [aria-hidden]')]
            .map((node) => node.style.background)
            .filter(Boolean);
          const uniqueColors = new Set(directoryColors).size;
          const firstDept = document.querySelector('[data-testid="org-department"]');
          firstDept?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
          document.querySelector('[data-testid="org-view-board"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 400));
          const boardColumns = document.querySelectorAll('[data-testid="board-column"]').length;
          const boardDimmed = [...document.querySelectorAll('[data-testid="board-column"]')].filter((node) =>
            node.className.includes('opacity-70'),
          ).length;
          const boardHire = document.querySelectorAll('[data-testid="board-hire"]').length;
          document.querySelector('[data-testid="org-view-tree"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));

          const diagnostics = await window.opc.diagnostics.report();
          return {
            orgMembers,
            orgDepartments,
            orgViews,
            orgCanvas,
            rosterRows,
            orgCards,
            orgFilter,
            orgTabs,
            panelBeforeClick,
            panelAfterCardClick,
            panelAfterClose,
            directoryToggle,
            showDirectory,
            orgHasUnassigned,
            marketRows,
            importButton,
            marketHero,
            marketEmpty,
            marketPool,
            expandToggles,
            wizardOpen,
            wizardSteps,
            newDeptFields,
            uniqueColors,
            boardColumns,
            boardDimmed,
            providerRows,
            providerIcons,
            llmTableScrollable,
            saveBox,
            imageIcons,
            imageRows,
            imageGenerateButton,
            imageTableScrollable,
            budget: employeeBudget
              ? { limit: employeeBudget.limitTokens, used: employeeBudget.usedTokens, available: employeeBudget.availableTokens, state: employeeBudget.state }
              : null,
            refused: refused.ok ? null : refused.error.code,
            task: finishedTask ? { status: finishedTask.status, verdict: finishedTask.acceptance?.verdict ?? null, artifacts: finishedTask.artifacts.length, exitCode: finishedTask.acceptance?.evidence.exitCode ?? null } : null,
            cardVisible,
            bossButtons,
            deptRulesForm,
            deptRuleVisible,
            archivedToggle,
            menuArchiveWorks,
            menuRestoreWorks,
            zoomChanged: zoomBefore !== zoomAfter,
            legend,
            boardHire,
            hasBridge: Boolean(window.opc),
            title: document.title,
            shell: document.documentElement.dataset.shell,
            platform: document.documentElement.dataset.platform,
            theme: document.documentElement.dataset.theme,
            heading: document.querySelector('h1')?.textContent ?? null,
            conversations: before.conversations.length,
            messagesBefore: conversation.messages.length,
            messagesAfter: afterCount,
            rendererRequire: typeof window.require,
            diagnosticsOk: diagnostics.probes.every((p) => p.status === 'ok'),
          };
        })()`);
				process.stdout.write(`SMOKE ${JSON.stringify(result)}\n`);
				app.exit(0);
			} catch (error) {
				console.error("SMOKE_FAILED", error);
				app.exit(1);
			}
		})();
	});
}
function hardenSession() {
	if (isDev) return;
	session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
		callback({ responseHeaders: {
			...details.responseHeaders,
			"Content-Security-Policy": ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'"]
		} });
	});
}
function bootstrap(): void {
  initAppPaths();

  const db = openCompanyDatabase(appPaths.database);
  // Smoke runs must not inherit an exhausted budget from earlier real runs.
  if (isSmoke) db.exec('DELETE FROM budget_reservation; DELETE FROM budget;');
  const credentialStore = new FileCredentialStore(`${appPaths.userData}/credentials.json`);
  const modelConfig = new ModelConfigService(db, credentialStore);
  const org = new OrgService(db);
  const market = new MarketService(db, org);
  // A fresh install gets a real two-department company created through `hire`;
  // there are no fixtures behind it and no seeded conversations.
  ensureFirstCompany(org);

  chat = new ChatService({
    db,
    agents: agentsFromOrg(org),
    departments: chatDepartmentsFromOrg(org),
    conversations: [],
  });

  // Consolidation summariser: the same provider the agents answer with, so nothing
  // is invented when no model is configured (consolidation then writes nothing).
  const summarize = async ({ messages: turns }: { messages: { senderId: string; text: string }[] }) => {
    const defaults = modelConfig.getDefaults().llm;
    if (!defaults) throw new Error('未配置默认 LLM 模型');
    const models = await modelConfig.runtime.createModels();
    const model = await modelConfig.runtime.resolveModel(defaults.providerId, defaults.modelId);
    if (!model) throw new Error('找不到模型');
    const transcript = turns.map((turn) => `${turn.senderId === 'user' ? '老板' : '员工'}：${turn.text}`).join('\n');
    const answer = await models.complete(model, {
      systemPrompt:
        '把这段对话里值得长期记住的经验、事实和老板偏好提炼成条目。每条一行，格式为「类型|内容」，类型只能是 experience/fact/preference。只提炼对话里明确出现的，不要推测。',
      messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
    } as never);
    const text = ((answer as { content?: { type: string; text?: string }[] }).content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('|'))
      .map((line) => {
        const [rawKind, ...rest] = line.split('|');
        const kind = (['experience', 'fact', 'preference'] as const).includes(
          rawKind!.trim() as 'experience' | 'fact' | 'preference',
        )
          ? (rawKind!.trim() as 'experience' | 'fact' | 'preference')
          : 'fact';
        return { kind, content: rest.join('|').trim() };
      })
      .filter((lesson) => lesson.content.length > 0);
  };
  chat.consolidate = async ({ conversationId, employeeId, messages: turns }) =>
    consolidateConversation(memory, { conversationId, employeeId, messages: turns }, summarize);

  // An agent answers with its own model. No provider → no answer, never a canned one.
  chat.replyWithModel = async ({ agent, text }) => {
    const defaults = modelConfig.getDefaults().llm;
    if (!defaults) throw new Error('未配置默认 LLM 模型');
    const models = await modelConfig.runtime.createModels();
    const model = await modelConfig.runtime.resolveModel(defaults.providerId, defaults.modelId);
    if (!model) throw new Error(`找不到模型 ${defaults.providerId}/${defaults.modelId}`);

    const answer = await models.complete(model, {
      systemPrompt: [
        `你是「${agent.name}」，岗位是 ${agent.role}。`,
        agent.briefMd ? `你的工作规范：${agent.briefMd}` : '',
        '用中文直接回答老板的问题，简短、具体，不要复述他的原话，也不要编造成果。',
      ]
        .filter(Boolean)
        .join('\n'),
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    } as never);

    const content = (answer as { content?: { type: string; text?: string }[] }).content ?? [];
    return content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
      .trim();
  };

  const memory = new MemoryService(db);
  const facts = new OrgFactService(db);
  const imageService = new ImageService(modelConfig, appPaths);
  work = new WorkService({
    db,
    paths: appPaths,
    agents: agentsFromOrg(org),
    upsertTaskCard: (task) => chat?.upsertTaskCard(task),
    modelConfig,
    images: imageService,
    org,
    memory,
    facts,
  });

  disposeIpc = registerIpc({
    chat,
    work,
    models: modelConfig,
    org,
    market,
    facts,
    images: imageService,
    auth: new AuthService(() => modelConfig.runtime.createModels(), credentialStore),
    workspaceRoot: appPaths.workspaceDir,
  });

  // Auto consolidation: a conversation idle for an hour is archived once, and its
  // lessons become memory. Probes drive this explicitly instead of waiting.
  if (!isHeadlessMode) {
    const timer = setInterval(() => {
      void chat?.sweepIdleConversations(60 * 60 * 1000).catch(() => undefined);
    }, 5 * 60 * 1000);
    app.on('before-quit', () => clearInterval(timer));
  }

  // Crash recovery: resume durable tasks the previous process left running, then
  // free any reservation whose task is gone.
  void work.recover();
  hardenSession();
  mainWindow = createMainWindow();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * One instance per installation: two writers on one SQLite file is a data bug.
 * Diagnostic/probe modes are short-lived by design and must stay runnable while
 * the app is open (otherwise CI and one-off probes silently no-op).
 */
const isHeadlessMode =
  isSelfTest ||
  isSmoke ||
  isWorkProbe ||
  isBudgetProbe ||
  isModelProbe ||
  isFactProbe ||
  isArchiveProbe ||
  isConsolidateProbe ||
  isMemoryProbe ||
  isChatPersistProbe ||
  isMarketSeed ||
  isResetCompany ||
  isFirstRunProbe ||
  isChatProbe ||
  isReviewProbe ||
  isMarketProbe;
const hasLock = isHeadlessMode ? true : app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.opc.agent.workspace');

    if (isFactProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok';
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-fact-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      ensureFirstCompany(org);
      const facts = new OrgFactService(db);
      const memory = new MemoryService(db);
      const member = org.list().flatMap((department) => department.members)[0]!;
      const departmentId = member.departmentId;

      const first = facts.write({ scopeType: 'org', subject: 'Q4目标', object: '先做留存', statement: 'Q4 目标：先做留存，不做新功能' });
      const second = facts.write({ scopeType: 'org', subject: 'Q4目标', object: '先做留存与复购', statement: 'Q4 目标：先做留存与复购' });
      facts.write({
        scopeType: 'department',
        scopeId: departmentId,
        subject: '交付规范',
        object: '必须带 README',
        statement: '部门规定：每个交付必须带 README',
      });
      facts.write({
        scopeType: 'department',
        scopeId: org.list()[1]?.id ?? departmentId,
        subject: '交付规范',
        object: '另一部门的私有规定',
        statement: '另一个部门的规定（不应该出现在本员工上下文里）',
      });

      const current = facts.current([{ type: 'org' }, { type: 'department', id: departmentId }]);
      const history = facts.history('Q4目标');

      const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(org),
        upsertTaskCard: () => undefined,
        org,
        memory,
        facts,
      });
      const created = work.createTask({
        title: '写季度留存方案',
        brief: '按公司 Q4 目标写',
        deliverableSpec: 'server.js 在 3000 端口返回 200',
        assigneeId: member.id,
        estTokens: 4000,
        acceptanceCommand: [],
        acceptanceTemplate: 'http-ok',
      });
      if (!created.ok) throw new Error('事实探针创建任务失败');
      const finished = await work.runTaskAndWait(created.task.id);

      process.stdout.write(
        JSON.stringify({
          probe: 'facts',
          firstSuperseded: first.id !== second.id && history.length === 2,
          currentStatements: current.map((fact) => fact.statement),
          leakedOtherDepartment: current.some((fact) => fact.statement.includes('另一个部门')),
          injectedIntoPrompt: finished.steps.find((step) => step.text.startsWith('注入'))?.text ?? null,
          taskStatus: finished.status,
        }) + '\n',
      );
      app.exit(current.length === 2 && !current.some((fact) => fact.statement.includes('另一个部门')) ? 0 : 1);
      return;
    }

    if (isArchiveProbe) {
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-archive-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      ensureFirstCompany(org);
      const member = org.list().flatMap((department) => department.members)[0]!;
      const memory = new MemoryService(db);

      const chatProbe = new ChatService({
        db,
        agents: agentsFromOrg(org),
        departments: chatDepartmentsFromOrg(org),
        conversations: [],
      });
      // Deterministic summariser stand-in; the real one is models.complete.
      chatProbe.consolidate = async ({ conversationId, employeeId, messages: turns }) => {
        const bossLines = turns.filter((turn) => turn.senderId === 'user').map((turn) => turn.text);
        let written = 0;
        for (const line of bossLines.filter((entry) => entry.includes('README'))) {
          await memory.remember({
            employeeId,
            kind: 'preference',
            content: `老板要求：${line}`,
            scope: { type: 'personal' },
            sourceType: 'consolidation',
            sourceId: conversationId,
          });
          written += 1;
        }
        return { written };
      };

      const conversationId = chatProbe.openDirect(member.id);
      chatProbe.sendMessage({ conversationId, text: '文档以后放 README 里就够了，别单开 wiki' });
      await new Promise((resolve) => setTimeout(resolve, 1600));

      // Nothing is idle yet.
      const early = await chatProbe.sweepIdleConversations(60 * 60 * 1000);
      // Backdate the row, as if the boss walked away an hour ago.
      db.prepare('UPDATE conversation SET updated_at = ? WHERE id = ?').run(
        Date.now() - 2 * 60 * 60 * 1000,
        conversationId,
      );
      const swept = await chatProbe.sweepIdleConversations(60 * 60 * 1000);
      const again = await chatProbe.sweepIdleConversations(0);
      const row = db
        .prepare('SELECT archived_at, consolidated_at FROM conversation WHERE id = ?')
        .get(conversationId) as { archived_at: number | null; consolidated_at: number | null };

      process.stdout.write(
        JSON.stringify({
          probe: 'archive',
          earlySweep: early.length,
          swept,
          idempotentSecondSweep: again.length,
          archivedAt: row.archived_at !== null,
          consolidatedAt: row.consolidated_at !== null,
          memories: memory.listForEmployee(member.id).map((item) => item.content),
        }) + '\n',
      );
      app.exit(
        early.length === 0 && swept.length === 1 && again.length === 0 && row.consolidated_at !== null ? 0 : 1,
      );
      return;
    }

    if (isConsolidateProbe) {
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-consolidate-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      ensureFirstCompany(org);
      const member = org.list().flatMap((department) => department.members)[0]!;
      const memory = new MemoryService(db);

      const conversation = {
        conversationId: 'conv-probe',
        employeeId: member.id,
        messages: [
          { senderId: 'user', text: '以后交付都先给我最小可运行版本，别一次性堆功能' },
          { senderId: member.id, text: '明白，先跑通再扩展。' },
          { senderId: 'user', text: '文档放 README 里就够了' },
        ],
      };

      // 1) no summarizer → nothing invented
      const withoutModel = await consolidateConversation(memory, conversation, undefined);

      // 2) with a summarizer (a deterministic stand-in for the model in this probe)
      const withModel = await consolidateConversation(memory, conversation, async ({ messages: turns }) => {
        const bossLines = turns.filter((turn) => turn.senderId === 'user').map((turn) => turn.text);
        return bossLines
          .filter((line) => line.includes('最小可运行') || line.includes('README'))
          .map((line) => ({
            content: `老板要求：${line}`,
            kind: 'preference' as const,
          }));
      });

      const stored = memory.listForEmployee(member.id);
      const recalled = await memory.retrieve({
        employeeId: member.id,
        query: '这单怎么交付，文档放哪',
        scopes: [{ type: 'personal' }],
        limit: 2,
      });

      process.stdout.write(
        JSON.stringify({
          probe: 'consolidate',
          withoutModel,
          withModel,
          stored: stored.map((item) => item.content),
          topRecall: recalled[0]?.content ?? null,
        }) + '\n',
      );
      app.exit(withModel.written === 2 && withoutModel.written === 0 ? 0 : 1);
      return;
    }

    if (isMemoryProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok';
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-memory-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      ensureFirstCompany(org);
      const member = org.list().flatMap((department) => department.members)[0]!;
      const memory = new MemoryService(db);

      await memory.remember({
        employeeId: member.id,
        kind: 'experience',
        content: '健康检查服务必须监听 3000 端口，验收脚本会用 curl 打 /health',
        scope: { type: 'personal' },
        sourceType: 'manual',
      });
      await memory.remember({
        employeeId: member.id,
        kind: 'preference',
        content: '老板偏好先给最小可运行版本，再补文档',
        scope: { type: 'personal' },
        sourceType: 'manual',
      });
      await memory.remember({
        employeeId: member.id,
        kind: 'experience',
        content: '配色只用语义 token，不写死 hex',
        scope: { type: 'personal' },
        sourceType: 'manual',
      });

      const recalled = await memory.retrieve({
        employeeId: member.id,
        query: '写一个健康检查服务，要能被 curl 验收',
        scopes: [{ type: 'personal' }],
        limit: 2,
      });
      const afterRecall = memory.listForEmployee(member.id).find((item) => item.id === recalled[0]?.id);
      const totalBefore = memory.countForEmployee(member.id);

      const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(org),
        upsertTaskCard: () => undefined,
        org,
        memory,
      });
      const created = work.createTask({
        title: '写健康检查服务',
        brief: 'node:http，/health 返回 200',
        deliverableSpec: 'server.js 在 3000 端口返回 200',
        assigneeId: member.id,
        estTokens: 4000,
        acceptanceCommand: [],
        acceptanceTemplate: 'http-ok',
      });
      if (!created.ok) throw new Error('记忆探针创建任务失败');
      const finished = await work.runTaskAndWait(created.task.id);
      const injected = finished.steps.find((step) => step.text.startsWith('注入'));

      process.stdout.write(
        JSON.stringify({
          probe: 'memory',
          written: totalBefore,
          topRecall: recalled[0]?.content ?? null,
          recallCount: afterRecall ? 1 : 0,
          injectedIntoPrompt: injected?.text ?? null,
          taskStatus: finished.status,
          memoriesAfterTask: memory.countForEmployee(member.id),
        }) + '\n',
      );
      app.exit(injected ? 0 : 1);
      return;
    }

    if (isChatPersistProbe) {
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      ensureFirstCompany(org);
      const member = org.list().flatMap((department) => department.members)[0];
      if (!member) throw new Error('聊天持久化探针需要至少一名员工');

      const first = new ChatService({ db, agents: agentsFromOrg(org), departments: chatDepartmentsFromOrg(org), conversations: [] });
      const conversationId = first.openDirect(member.id);
      first.sendMessage({ conversationId, text: '最近有什么产品上线了么' });
      // The reply arrives on a timer (typing indicator first), so let it land.
      await new Promise((resolve) => setTimeout(resolve, 1600));
      const firstSnapshot = first.getSnapshot();
      const firstCount = firstSnapshot.conversations.find((item) => item.id === conversationId)?.messages.length ?? 0;
      first.dispose();

      // "Restart": a brand-new service reading the same SQLite file.
      const second = new ChatService({ db, agents: agentsFromOrg(org), departments: chatDepartmentsFromOrg(org), conversations: [] });
      const restored = second.getSnapshot().conversations.find((item) => item.id === conversationId);
      const restoredTexts = (restored?.messages ?? []).map((message) => message.text ?? message.kind);

      process.stdout.write(
        JSON.stringify({
          probe: 'chat-persist',
          conversationId,
          messagesBeforeRestart: firstCount,
          conversationsAfterRestart: second.getSnapshot().conversations.length,
          restoredMessages: restoredTexts,
          repliedHonestly: restoredTexts.some((text) => typeof text === 'string' && text.includes('还没配置可用模型')) ||
            restoredTexts.some((text) => typeof text === 'string' && text.includes('模型调用失败')),
          persists: firstCount > 0 && restoredTexts.length === firstCount,
        }) + '\n',
      );
      second.dispose();
      app.exit(firstCount > 0 && restoredTexts.length === firstCount ? 0 : 1);
      return;
    }

    if (isMarketSeed) {
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      ensureFirstCompany(org);
      const market = new MarketService(db, org);
      market.importJson(
        JSON.stringify({
          format: 'opc-agent-package@1',
          name: 'design-pack.json',
          agents: [
            {
              name: '苏晚',
              role: '视觉设计师',
              level: 'P6',
              model: '',
              skills: ['Figma', '信息图', '配色'],
              persona: '先给两级方案再展开细节。\n图纸必须能实现，配色只用语义 token。\n交付前自检对比度。',
            },
          ],
        }),
        'design-pack.json',
      );
      process.stdout.write(
        JSON.stringify({ probe: 'market-seed', candidates: market.list().map((item) => item.name) }) + '\n',
      );
      app.exit(0);
      return;
    }

    if (isResetCompany) {
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      const removed = resetCompany(db);
      const first = ensureFirstCompany(org);
      let duplicateRejected = false;
      try {
        org.createDepartment({ name: ' 产品部 ' });
      } catch (error) {
        duplicateRejected = error instanceof Error && error.message.includes('部门名称已存在');
      }
      let duplicateCodeRejected = false;
      try {
        org.createDepartment({ name: '产品二部', code: ' pd-01 ' });
      } catch (error) {
        duplicateCodeRejected = error instanceof Error && error.message.includes('部门代号已存在');
      }
      const movable = org
        .list()
        .flatMap((department) => department.members)
        .find((member) => !member.isHead);
      const withHead = org.createDepartment({
        name: '增长部',
        code: 'GR-01',
        description: '负责拉新与留存实验。',
        headEmployeeId: movable?.id,
      });
      const movedHead = withHead.members.find((member) => member.isHead);
      // Leave the company as the seed created it: drop the probe department again.
      db.prepare('DELETE FROM position WHERE department_id = ?').run(withHead.id);
      db.prepare('DELETE FROM department WHERE id = ?').run(withHead.id);

      const departments = org.list();
      process.stdout.write(
        JSON.stringify({
          probe: 'reset-company',
          headAppointed: movedHead ? `${movedHead.name}@${withHead.name}` : null,
          headDepartment: movedHead?.departmentId === withHead.id,
          removed,
          seeded: first,
          duplicateRejected,
          duplicateCodeRejected,
          departments: departments.map((department) => `${department.name}:${department.members.length}`),
          names: departments.map((department) => department.name),
          uniqueNames: new Set(departments.map((department) => department.name)).size,
        }) + '\n',
      );
      app.exit(0);
      return;
    }

    if (isFirstRunProbe) {
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-first-run-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      const first = ensureFirstCompany(org);
      const second = ensureFirstCompany(org);
      const departments = org.list();
      const employees = departments.flatMap((department) => department.members);
      const chat = new ChatService({
        agents: agentsFromOrg(org),
        departments: chatDepartmentsFromOrg(org),
        conversations: [],
      });
      const snapshot = chat.getSnapshot();
      process.stdout.write(
        JSON.stringify({
          probe: 'first-run',
          createdOnFirstCall: first.created,
          createdOnSecondCall: second.created,
          departments: departments.map((department) => `${department.name}:${department.members.length}`),
          employees: employees.map((member) => `${member.name}/${member.title}/${member.level}`),
          heads: employees.filter((member) => member.isHead).map((member) => member.name),
          reportingLines: employees.filter((member) => member.reportsToEmployeeId).length,
          seededConversations: snapshot.conversations.length,
          storedRows: (
            db.prepare('SELECT COUNT(*) AS n FROM employee WHERE status = ?').get('active') as { n: number }
          ).n,
        }) + '\n',
      );
      app.exit(0);
      return;
    }

    if (isChatProbe) {
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      const department = org.list().find((node) => node.members.length > 0);
      if (!department) throw new Error('聊天探针需要至少一个有成员的部门');
      const member = department.members[0]!;
      const service = new ChatService({
        agents: department.members.map((entry) => ({
          id: entry.id,
          name: entry.name,
          role: entry.role,
          level: entry.level,
          departmentId: department.id,
          model: entry.model,
          status: 'online' as const,
          skills: entry.skills,
          briefMd: entry.persona,
        })),
        departments: [
          {
            id: department.id,
            name: department.name,
            code: department.code,
            color: department.color,
            description: department.description,
            leadAgentId: department.headEmployeeId ?? '',
            groupConversationId: '',
          },
        ],
        conversations: [],
      });
      const directA = service.openDirect(member.id);
      const directB = service.openDirect(member.id);
      const groupA = service.ensureDepartmentGroup(department.id);
      const groupB = service.ensureDepartmentGroup(department.id);
      const snapshot = service.getSnapshot();
      const direct = snapshot.conversations.find((item) => item.id === directA);
      const group = snapshot.conversations.find((item) => item.id === groupA);
      process.stdout.write(
        JSON.stringify({
          probe: 'chat',
          conversations: snapshot.conversations.length,
          directReused: directA === directB,
          directTitle: direct?.title ?? null,
          directMembers: direct?.memberIds.length ?? 0,
          groupReused: groupA === groupB,
          groupTitle: group?.title ?? null,
          groupMembers: group?.memberIds.length ?? 0,
        }) + '\n',
      );
      app.exit(
        directA === directB && groupA === groupB && snapshot.conversations.length === 2 ? 0 : 1,
      );
      return;
    }

    if (isReviewProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok';
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      db.exec(
        'DELETE FROM acceptance; DELETE FROM artifact; DELETE FROM task_step; DELETE FROM task; DELETE FROM budget_reservation;',
      );
      org.createDepartment({ name: '验收部', code: 'RV-01' });
      const dept = org.list().find((node) => node.code === 'RV-01')!;
      const manager = org.hire({ name: '主管甲', role: '技术主管', departmentId: dept.id, isHead: true });
      const worker = org.hire({ name: '组员乙', role: '工程师', departmentId: dept.id, reportsToEmployeeId: manager.id });

      const work = new WorkService({
        db,
        paths: appPaths,
        agents: [manager, worker].map((member): Agent => ({
          id: member.id,
          name: member.name,
          role: member.role,
          level: member.level,
          model: '',
          departmentId: dept.id,
          status: 'online' as Agent['status'],
          skills: [] as string[],
          briefMd: '',
        })),
        upsertTaskCard: () => undefined,
        org,
      });
      const created = work.createTask({
        title: '写一个健康检查服务',
        brief: 'node:http，/health 返回 200',
        deliverableSpec: 'server.js 在 3000 端口返回 200',
        assigneeId: worker.id,
        estTokens: 5000,
        acceptanceCommand: [],
        acceptanceTemplate: 'http-ok',
      });
      if (!created.ok) {
        process.stdout.write(JSON.stringify({ probe: 'review', ok: false }) + '\n');
        app.exit(1);
        return;
      }
      void work.runTaskAndWait(created.task.id).then(async () => {
        // The review task runs on its own; wait for it to settle.
        for (let i = 0; i < 240; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const after = work.getTask(created.task.id);
          const review = work.listReviews(created.task.id)[0];
          const settled = review?.status === 'accepted' || review?.status === 'failed' || review?.status === 'rejected';
          if (after && settled && (after.status === 'accepted' || after.status === 'rejected')) break;
        }
        const final = work.getTask(created.task.id)!;
        const afterRevise = work.getTask(created.task.id)!;
        const delivered = afterRevise.status === 'accepted' ? work.bossDecision(created.task.id, 'approve') : null;
        const reviewList = work.listReviews(created.task.id);
        process.stdout.write(
          JSON.stringify({
            probe: 'review',
            finalStatus: final.status,
            acceptanceLevels: final.acceptance ? final.acceptance.reason : null,
            error: final.error ?? null,
            reviewTasks: reviewList.length,
            reviewStatus: reviewList[0]?.status ?? null,
            reworkRounds: reviewList.length,
            bossStatus: delivered?.status ?? null,
          }) + '\n',
        );
        app.exit(final.status === 'accepted' || final.status === 'delivered' ? 0 : 1);
      });
      return;
    }

    if (isMarketProbe) {
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      const market = new MarketService(db, org);
      db.exec('DELETE FROM agent_candidate;');
      const target = org.list()[0];
      if (!target) throw new Error('市场探针需要至少一个部门');
      const imported = market.importJson(
        JSON.stringify({
          format: 'opc-agent-package@1',
          name: 'probe-pack.json',
          agents: [
            { name: '包小满', role: '数据工程师', level: 'P6', model: 'gpt-5', skills: ['SQL', 'DuckDB'], persona: '你只交付可复现的数据查询。' },
            { name: '坏包', role: '' },
          ],
        }),
        'probe-pack.json',
      );
      market.hire(imported[0]!.id, { departmentId: target.id });
      const hired = org.list().flatMap((node) => node.members).find((member) => member.name === '包小满');
      process.stdout.write(
        JSON.stringify({
          probe: 'market',
          importedCount: imported.length,
          inferredFields: imported[0]?.skills,
          remainingCandidates: market.list().length,
          hiredInto: target.name,
          hiredSkills: hired?.skills,
          personaStored: hired?.persona,
          level: hired?.level,
        }) + '\n',
      );
      app.exit(0);
      return;
    }

    if (isDecomposeProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok';
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      db.exec("DELETE FROM position; DELETE FROM department;");
      org.createDepartment({ name: '交付部', code: 'QA-01' });
      const dept = org.list().find((node) => node.code === 'QA-01')!;

      const manager = org.hire({ name: '李雷', role: '交付总监', level: 'M2', departmentId: dept.id, isHead: true });
      const worker = org.hire({
        name: '韩梅梅',
        role: '前端工程师',
        level: 'P6',
        departmentId: dept.id,
        reportsToEmployeeId: manager.id,
      });
      const outsider = org.hire({ name: '外人', role: '别的部门', level: 'P6', departmentId: dept.id });

        const probeOrg = new OrgService(db);
        ensureFirstCompany(probeOrg);
        const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(probeOrg),
        upsertTaskCard: () => undefined,
        org,
      });
      db.exec('DELETE FROM budget_reservation; DELETE FROM budget;');

      const parent = work.createTask({ ...DEMO_TASK, assigneeId: manager.id, estTokens: 20000 });
      if (!parent.ok) {
        process.stdout.write(`${JSON.stringify({ parentRefused: parent.error })}\n`);
        app.exit(2);
        return;
      }

      const good: SubtaskDraft[] = [
        {
          title: '写页面',
          brief: '按交付物要求写前端页面',
          deliverableSpec: 'server.js：GET / 返回 ok',
          assigneeId: worker.id,
          estTokens: 6000,
          acceptanceTemplate: 'http-ok',
        },
      ];
      const created = work.decompose(parent.task.id, manager.id, good);
      const refusals = {
        subordinate: work.decompose(parent.task.id, manager.id, [
          { ...good[0]!, assigneeId: outsider.id },
        ]),
        fanout: work.decompose(parent.task.id, manager.id, Array.from({ length: 6 }, (_, index) => ({
          ...good[0]!,
          title: `子任务 ${index}`,
        }))),
        budget: work.decompose(parent.task.id, manager.id, [{ ...good[0]!, estTokens: 999999 }]),
        self: work.decompose(parent.task.id, manager.id, [{ ...good[0]!, assigneeId: manager.id }]),
        depth: (() => {
          // Put the parent at maxDepth-1 so the next level is refused.
          db.prepare('UPDATE task SET depth = 2 WHERE id = ?').run(parent.task.id);
          const result = work.decompose(parent.task.id, manager.id, good);
          db.prepare('UPDATE task SET depth = 0 WHERE id = ?').run(parent.task.id);
          return result;
        })(),
      };

      const childResults: string[] = [];
      if (created.ok) {
        for (const child of created.created) {
          const finished = await work.runTaskAndWait(child.id);
          childResults.push(`${finished.title}:${finished.status}`);
        }
      }

      process.stdout.write(
        `${JSON.stringify(
          {
            created: created.ok ? created.created.map((task) => `${task.assigneeName}:${task.title}@${task.depth}`) : created,
            refusals: Object.fromEntries(
              Object.entries(refusals).map(([key, value]) => [key, value.ok ? 'accepted?' : value.error.code]),
            ),
            childResults,
            subtree: work.listTasks().filter((task) => task.id === parent.task.id || task.parentTaskId === parent.task.id)
              .map((task) => ({ title: task.title, depth: task.depth, status: task.status })),
          },
          null,
          2,
        )}\n`,
      );
      await work.dispose();
      app.exit(created.ok && childResults.every((entry) => entry.endsWith('accepted')) ? 0 : 1);
      return;
    }

    if (isOrgProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok';
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
        const probeOrg = new OrgService(db);
        ensureFirstCompany(probeOrg);
        const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(probeOrg),
        upsertTaskCard: () => undefined,
      });
      const org = new OrgService(db);
      // Deterministic probe: reset the org projection, keep employees.
      db.exec("DELETE FROM position; UPDATE department SET deleted_at = NULL");
      ensureFirstCompany(org);
  org.ensureDistinctColors();
      db.exec('DELETE FROM budget_reservation; DELETE FROM budget;');

      const department = org.createDepartment({ name: '交付部', code: 'QA-01' });
      const hired = org.hire({ name: '林小舟', role: '前端工程师', level: 'P6', departmentId: department.id });

      const created = work.createTask({
        ...DEMO_TASK,
        assigneeId: hired.id,
      });
      const finished = created.ok ? await work.runTaskAndWait(created.task.id) : null;

      org.fire(hired.id);
      const afterFire = work.createTask({ ...DEMO_TASK, assigneeId: hired.id });

      const tree = org.list();
      process.stdout.write(
        `${JSON.stringify(
          {
            departments: tree.map((node) => `${node.name}(${node.members.length})`),
            hiredId: hired.id,
            dispatched: created.ok,
            taskStatus: finished?.status ?? null,
            afterFireRefused: afterFire.ok ? null : afterFire.error.code ?? 'refused',
            afterFireMessage: afterFire.ok ? null : afterFire.error.message,
          },
          null,
          2,
        )}\n`,
      );
      await work.dispose();
      app.exit(
        created.ok && finished?.status === 'accepted' && !afterFire.ok ? 0 : 1,
      );
      return;
    }

    if (isImageLoopProbe) {
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);

      // A local OpenAI-compatible image endpoint: proves the loop end to end
      // without a real provider key.
      const { createServer } = await import('node:http');
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      );
      const server = createServer((request, response) => {
        if (request.url?.includes('/images/generations')) {
          response.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }),
          );
          return;
        }
        response.writeHead(404).end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;

      const credentialStore = new FileCredentialStore(`${appPaths.userData}/credentials.json`);
      const modelConfig = new ModelConfigService(db, credentialStore);
      modelConfig.importFromPi();
      modelConfig.saveProvider({
        id: 'mock-image',
        name: 'Mock Image',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: 'openai-completions',
        isCustom: true,
      });
      modelConfig.setKey('mock-image', 'test-key');
      modelConfig.setModels('mock-image', [
        { id: 'mock/png-1', name: 'Mock PNG', capability: 'image', api: 'openai-images' },
      ]);
      modelConfig.setDefault('image', { providerId: 'mock-image', modelId: 'mock/png-1' });

      const images = new ImageService(modelConfig, appPaths);
        const probeOrg = new OrgService(db);
        ensureFirstCompany(probeOrg);
        const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(probeOrg),
        upsertTaskCard: () => undefined,
        modelConfig,
        images,
      });

      db.exec('DELETE FROM budget_reservation; DELETE FROM budget;');
      const created = work.createTask({
        title: '生成一张占位图片',
        brief:
          '必须调用 generate_image 工具生成一张图片，filename 用 icon.png。不要自己写 Base64，也不要只回复文字。',
        deliverableSpec: 'icon.png：一张 PNG 图片',
        assigneeId: 'agent-fe',
        estTokens: 6000,
        acceptanceCommand: ['node', '{checks}/verify.mjs'],
        acceptanceTemplate: 'image-200',
      });

      if (!created.ok) {
        process.stdout.write(`${JSON.stringify({ refused: created.error })}\n`);
        server.close();
        app.exit(2);
        return;
      }

      const finished = await work.runTaskAndWait(created.task.id);
      process.stdout.write(
        `${JSON.stringify(
          {
            status: finished.status,
            verdict: finished.acceptance?.verdict ?? null,
            template: finished.acceptanceTemplate,
            exitCode: finished.acceptance?.evidence.exitCode ?? null,
            artifacts: finished.artifacts.map((artifact) => `${artifact.relPath} (${artifact.bytes}B)`),
            steps: finished.steps.map((step) => step.text),
            error: finished.error ?? null,
          },
          null,
          2,
        )}\n`,
      );
      server.close();
      await work.dispose();
      app.exit(finished.status === 'accepted' ? 0 : 1);
      return;
    }

    if (crashProbe === 'start') {
      process.env.OPC_BRAIN_VARIANT ??= 'ok'; // probes are deterministic and must not spend tokens
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
        const probeOrg = new OrgService(db);
        ensureFirstCompany(probeOrg);
        const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(probeOrg),
        upsertTaskCard: () => undefined,
      });
      db.exec('DELETE FROM budget_reservation; DELETE FROM budget;');
      const created = work.createTask({ ...DEMO_TASK, assigneeId: 'agent-fe' });
      if (!created.ok) {
        process.stdout.write(`${JSON.stringify({ refused: created.error })}\n`);
        app.exit(2);
        return;
      }
      process.stdout.write(`${JSON.stringify({ started: created.task.id })}\n`);
      work.runTask(created.task.id);
      // Stay alive; the test harness kills this process mid-run.
      return;
    }

    if (crashProbe === 'resume') {
      process.env.OPC_BRAIN_VARIANT ??= 'ok'; // probes are deterministic and must not spend tokens
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
        const probeOrg = new OrgService(db);
        ensureFirstCompany(probeOrg);
        const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(probeOrg),
        upsertTaskCard: () => undefined,
      });
      const before = work.listTasks().filter((task) => task.status === 'running').length;

      // Orphan reservation: task id that no longer exists. The reaper must free it.
      const orphanId = `reservation-orphan-${Date.now()}`;
      db.prepare(
        `INSERT INTO budget_reservation (id, budget_id, task_id, employee_id, est_tokens, status, expires_at, created_at)
         VALUES (?, (SELECT id FROM budget WHERE scope='employee' LIMIT 1), 'task-gone', 'agent-fe', 1234, 'active', NULL, ?)`,
      ).run(orphanId, Date.now());
      db.prepare(`UPDATE budget SET reserved_tokens = reserved_tokens + 1234 WHERE scope='employee'`).run();

      await work.recover();
      const orphan = db
        .prepare('SELECT status FROM budget_reservation WHERE id = ?')
        .get(orphanId) as { status: string } | undefined;

      const deadline = Date.now() + 30_000;
      let latest = work.listTasks()[0];
      while (Date.now() < deadline) {
        latest = work.listTasks()[0];
        if (latest && latest.status !== 'running' && latest.status !== 'open') break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      process.stdout.write(
        `${JSON.stringify(
          {
            runningBeforeRecovery: before,
            status: latest?.status ?? null,
            attempts: latest?.attempts ?? null,
            exitCode: latest?.acceptance?.evidence.exitCode ?? null,
            resumedSteps:
              latest?.steps
                .map((step) => step.text)
                .filter((text) => text.includes('继续') || text.includes('启动恢复')) ?? [],
            orphanReservation: orphan?.status ?? null,
          },
          null,
          2,
        )}\n`,
      );
      await work.dispose();
      app.exit(latest?.status === 'accepted' ? 0 : 1);
      return;
    }

    if (isModelProbe) {
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const credentialStore = new FileCredentialStore(`${appPaths.userData}/credentials.json`);
      const modelConfig = new ModelConfigService(db, credentialStore);
      const imported = modelConfig.importFromPi();
      const defaults = modelConfig.getDefaults();
      // Price the model so the ledger has a money column to verify.
      if (defaults.llm) {
        modelConfig.setModelPricing(defaults.llm.providerId, defaults.llm.modelId, {
          input: 0.14,
          output: 0.28,
          cacheRead: 0.014,
          cacheWrite: 0.14,
        });
      }

        const probeOrg = new OrgService(db);
        ensureFirstCompany(probeOrg);
        const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(probeOrg),
        upsertTaskCard: () => undefined,
        modelConfig,
      });

      db.exec('DELETE FROM budget_reservation; DELETE FROM budget;');
      const created = work.createTask({ ...DEMO_TASK, assigneeId: 'agent-fe' });
      if (!created.ok) {
        process.stdout.write(`${JSON.stringify({ refused: created.error }, null, 2)}\n`);
        app.exit(2);
        return;
      }

      const finished = await work.runTaskAndWait(created.task.id);
      process.stdout.write(
        `${JSON.stringify(
          {
            importedProviders: imported.imported,
            defaultLlm: defaults.llm,
            status: finished.status,
            verdict: finished.acceptance?.verdict ?? null,
            exitCode: finished.acceptance?.evidence.exitCode ?? null,
            steps: finished.steps.map((step) => step.text),
            error: finished.error ?? null,
            artifactChars: finished.artifacts[0]?.bytes ?? 0,
            tokensUsed: finished.tokensUsed,
            costUsd: finished.costUsd,
          },
          null,
          2,
        )}\n`,
      );
      await work.dispose();
      app.exit(finished.status === 'accepted' ? 0 : 1);
      return;
    }

    if (isBudgetProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok'; // probes are deterministic and must not spend tokens
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      // Probes must be deterministic: start from an empty ledger/reservation state.
      db.exec('DELETE FROM budget_reservation; DELETE FROM budget;');
        const probeOrg = new OrgService(db);
        ensureFirstCompany(probeOrg);
        const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(probeOrg),
        upsertTaskCard: () => undefined,
      });
      const draft = { ...DEMO_TASK, assigneeId: 'agent-fe' } as const;
      const snapshot = () =>
        work.listBudgets().find((budget) => budget.scope === 'employee' && budget.scopeId === 'agent-fe');

      const first = work.createTask({ ...draft, estTokens: 6000 });
      const second = work.createTask({ ...draft, estTokens: 6000 });
      const afterReserve = snapshot();

      if (first.ok) {
        const finished = await work.runTaskAndWait(first.task.id);
        work.runTask(first.task.id);
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (finished.status !== 'accepted') {
          process.stdout.write(`${JSON.stringify({ unexpected: finished.status, error: finished.error })}\n`);
        }
      }
      // The fire-and-forget run above charges the ledger; give it a beat, then read again.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const afterSettle = snapshot();

      const third = work.createTask({ ...draft, estTokens: 6000 });

      // Simulate a fully spent month to exercise the hard-stop latch.
      db.prepare(
        `UPDATE budget SET used_tokens = limit_tokens WHERE scope = 'employee' AND scope_id = 'agent-fe'`,
      ).run();
      const stopped = work.createTask({ ...draft, estTokens: 1000 });

      process.stdout.write(
        `${JSON.stringify(
          {
            firstOk: first.ok,
            secondRefused: second.ok ? null : second.error.code,
            thirdAfterSettleOk: third.ok,
            stoppedRefused: stopped.ok ? null : stopped.error.code,
            budgetAfterReserve: afterReserve && {
              limit: afterReserve.limitTokens,
              used: afterReserve.usedTokens,
              reserved: afterReserve.reservedTokens,
              available: afterReserve.availableTokens,
            },
            budgetAfterSettle: afterSettle && {
              limit: afterSettle.limitTokens,
              used: afterSettle.usedTokens,
              reserved: afterSettle.reservedTokens,
              available: afterSettle.availableTokens,
            },
          },
          null,
          2,
        )}\n`,
      );
      await work.dispose();
      app.exit(
        first.ok && !second.ok && second.error.code === 'BUDGET_EXCEEDED' && third.ok && !stopped.ok && stopped.error.code === 'BUDGET_STOPPED'
          ? 0
          : 1,
      );
      return;
    }

    if (isWorkProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok'; // probes are deterministic and must not spend tokens
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
        const probeOrg = new OrgService(db);
        ensureFirstCompany(probeOrg);
        const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(probeOrg),
        upsertTaskCard: () => undefined,
      });
      // Probes must be deterministic: start from an empty ledger/reservation state.
      db.exec('DELETE FROM budget_reservation; DELETE FROM budget;');
      try {
        const created = work.createTask({ ...DEMO_TASK, assigneeId: 'agent-fe' });
        if (!created.ok) {
          process.stdout.write(`${JSON.stringify({ refused: created.error }, null, 2)}\n`);
          await work.dispose();
          app.exit(2);
          return;
        }
        const finished = await work.runTaskAndWait(created.task.id);
        process.stdout.write(
          `${JSON.stringify(
            {
              taskId: finished.id,
              status: finished.status,
              assignee: finished.assigneeName,
              artifacts: finished.artifacts,
              acceptance: finished.acceptance,
              steps: finished.steps.map((step) => step.text),
            },
            null,
            2,
          )}\n`,
        );
        await work.dispose();
        app.exit(finished.status === 'accepted' ? 0 : 1);
      } catch (error) {
        console.error('WORK_PROBE_FAILED', error);
        app.exit(1);
      }
      return;
    }

    if (isSelfTest) {
      initAppPaths();
      const { runDiagnostics } = await import('./diagnostics/report');
      const report = await runDiagnostics();
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      app.exit(report.errors.length > 0 ? 1 : 0);
      return;
    }

    bootstrap();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Graceful shutdown: flush the service and close IPC before the process dies.
  app.on('before-quit', () => {
    disposeIpc?.();
    disposeIpc = null;
    chat?.dispose();
    chat = null;
    void work?.dispose();
    work = null;
  });
}
