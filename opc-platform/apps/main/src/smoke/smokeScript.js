(async () => {
  // 端到端冒烟：只走**现在真实存在**的桥与页面（worker / thread / chat / issues /
  // settings / skills）。组织架构、人才市场、项目页在 v2 里已经删掉，脚本里不再
  // 引用它们——否则第一次导航就会抛 "Cannot read properties of undefined"。
  const hasBridge = Boolean(window.opc);
  if (!hasBridge) throw new Error('window.opc 不存在：preload 没有注入');

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const go = async (hash, ms = 600) => {
    location.hash = hash;
    await wait(ms);
  };
  const click = (testId) =>
    document.querySelector('[data-testid="' + testId + '"]')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
  const count = (selector) => document.querySelectorAll(selector).length;

  // ── 执行体：全新安装正好一个，且它就是「干活的那一方」 ──────────────────
  const workers = await window.opc.workers.list();
  const executor = workers[0];
  if (!executor) throw new Error('没有执行体：seedExecutor 没有在启动时跑');
  const executorShape = {
    count: workers.length,
    name: executor.name,
    template: executor.template,
    status: executor.status,
    skills: executor.skills.length,
    hasThread: executor.threadId !== null,
  };

  // ── 工作台的规矩：写进去就该读得到（scope 与 org 表无关，只是 id） ──────────
  await window.opc.facts.write({
    scopeType: 'org',
    subject: 'smoke',
    object: '规矩写进去就能读回来',
  });

  // ── 你 ↔ Router 的唯一会话：发一句话，快照要跟着动 ────────────────────
  const conversationId = await window.opc.chat.ensureAssistant();
  const opening = await window.opc.chat.getSnapshot();
  const conversation = opening.conversations.find((item) => item.id === conversationId);
  if (!conversation) throw new Error('ensureAssistant 返回的会话不在快照里');
  const messagesBefore = conversation.messages.length;
  const replyArrived = new Promise((resolve) => {
    const off = window.opc.chat.onSnapshot((snapshot) => {
      const current = snapshot.conversations.find((item) => item.id === conversationId);
      if (current && current.messages.length > messagesBefore) {
        off();
        resolve(current.messages.length);
      }
    });
    setTimeout(() => {
      off();
      resolve(-1);
    }, 8000);
  });
  await window.opc.chat.sendMessage({ conversationId, text: 'smoke: 检查交付进度' });
  const messagesAfter = await replyArrived;

  // ── 一条真任务：建 → 跑 → 终态。归属必须是执行体 + 工作线 ───────────────
  const created = await window.opc.work.createTask({
    title: '写一个 hello world HTTP 服务',
    brief: '用 Node 内置 http 模块实现：GET / 返回 ok。',
    deliverableSpec: 'server.js：node server.js 启动，GET / 返回 ok',
    assigneeId: executor.id,
    estTokens: 6000,
    acceptanceCommand: ['node', '{checks}/verify.mjs'],
    acceptanceTemplate: 'http-ok',
  });
  if (!created.ok) throw new Error('创建任务被拒绝: ' + created.error.code);
  const task = created.task;

  const terminal = new Promise((resolve) => {
    const off = window.opc.work.onTaskChanged((changed) => {
      if (
        changed.id === task.id &&
        ['accepted', 'delivered', 'rejected', 'failed', 'cancelled'].includes(changed.status)
      ) {
        off();
        resolve(changed);
      }
    });
    // 真模型 + 工具可能跑很久；只在超时后放弃等待，不把超时当成失败。
    setTimeout(() => {
      off();
      resolve(null);
    }, 90000);
  });
  await window.opc.work.runTask(task.id);
  const finishedTask = await terminal;

  const stored = (await window.opc.work.listTasks(50)).find((row) => row.id === task.id) ?? null;
  if (!stored) throw new Error('任务建完却不在 listTasks 里');
  if (!stored.workerId) throw new Error('任务没有执行体归属：v2 里 workerId 必须落库');
  if (!stored.threadId) throw new Error('任务没有工作线归属：v2 里每条任务都该有一条线');

  // 动作流（W6）：接口必须真的接上，而且不能串任务。条数取决于这一轮有没有真跑 pi，
  // 所以这里只报数字、不硬要求 > 0——用脚本化执行器跑时本来就没有工具调用。
  const traceRows = await window.opc.work.trace(task.id, 20);
  if (!Array.isArray(traceRows)) throw new Error('work.trace 没返回数组');
  if (traceRows.some((row) => row.taskId !== task.id)) throw new Error('动作流串了别的任务');

  // 任务卡必须回到你眼前的那个会话（分配者的 DM，没有就落到第一条会话）。
  const cardVisible = (await window.opc.chat.getSnapshot()).conversations.some((item) =>
    item.messages.some((message) => message.kind === 'task' && message.task && message.task.id === task.id),
  );

  // ── 空目标必须被结构化拒绝，而不是让窗口崩掉 ────────────────────────────
  let emptyGoalRejected = false;
  try {
    await window.opc.threads.start('   ');
  } catch {
    emptyGoalRejected = true;
  }
  const threads = await window.opc.threads.list(20);

  // ── 能力清单：读的是运行时注册表，不是一份手写文档 ──────────────────────
  const catalog = await window.opc.capabilities.list();
  const capability = catalog.agents[0] ?? null;
  const capabilityShape = capability
    ? {
        workerId: typeof capability.workerId === 'string',
        template: capability.template,
        status: capability.status,
        tools: capability.tools.length,
        extensions: capability.extensions.length,
        skills: capability.skills.length,
      }
    : null;

  // ── issues 页：行、key、详情、过滤、四种视图、批量、拖拽拒绝、优先级 ────
  await go('#/issues', 900);
  const issueRows = count('[data-testid="issue-row"]');
  if (issueRows === 0) throw new Error('issues 页没有任何任务行');
  const firstRowText = document.querySelector('[data-testid="issue-row"]')?.textContent ?? '';
  const issueKeyLooksRight = /[A-Z0-9]{2,8}-\d+/.test(firstRowText);

  click('issue-row');
  await wait(400);
  const issueDetailOpen = Boolean(document.querySelector('[data-testid="issue-detail-close"]'));
  const issuePrioritySelect = Boolean(document.querySelector('[data-testid="issue-priority-select"]'));
  click('issue-detail-close');
  await wait(200);

  click('issue-filter-delivered');
  await wait(300);
  const issueFilteredRows = count('[data-testid="issue-row"]');
  click('issue-filter-all');
  await wait(200);

  // Priority 是桥写进库的事实，必须能在台账里读回来。
  const sampleTask = (await window.opc.work.listTasks(1))[0];
  if (sampleTask) {
    await window.opc.work.setIssueMeta(sampleTask.id, { priority: 'P0', labels: ['smoke'] });
  }
  await go('#/settings?page=appearance', 200);
  await go('#/issues', 700);
  click('issue-mode-ledger');
  await wait(300);
  const issuePriorityShown = [...document.querySelectorAll('[data-testid="issue-priority"]')].some(
    (node) => node.textContent === 'P0',
  );

  click('issue-mode-board');
  await wait(400);
  const issueColumns = count('[data-testid^="issue-column-"]');
  const issueCards = count('[data-testid="issue-card"]');
  // 拖到「系统验收」必须被拒绝：那是执行闸门判的，不是拖出来的。
  const card = document.querySelector('[data-testid="issue-card"]');
  const reviewColumn = document.querySelector('[data-testid="issue-column-system-review"]');
  if (card && reviewColumn) {
    card.dispatchEvent(new Event('dragstart', { bubbles: true }));
    await wait(200);
    reviewColumn.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
  }
  await wait(300);
  const issueRefusalShown = Boolean(document.querySelector('[data-testid="issue-notice"]'));

  click('issue-mode-timeline');
  await wait(400);
  const issueTimelineBars = count('[data-testid="issue-timeline"] li');
  const issueBurndown = Boolean(document.querySelector('[data-testid="issue-burndown"]'));

  click('issue-mode-people');
  await wait(400);
  const issuePeopleRows = count('[data-testid="issue-person-row"]');

  click('issue-mode-ledger');
  await wait(300);
  click('issue-pick');
  await wait(300);
  const issueBulkBar = Boolean(document.querySelector('[data-testid="issue-bulk"]'));
  click('issue-pick');
  await wait(200);

  // ── 聊天页：任务卡与你身份卡 ──────────────────────────────────────────
  await go('#/chat', 900);
  const userVerdictButtons = count('[data-testid="user-approve"]');
  const identityTrigger = Boolean(document.querySelector('[data-testid="identity-trigger"]'));
  click('identity-trigger');
  await wait(300);
  const identityCardOpens = Boolean(document.querySelector('[data-testid="identity-card"]'));
  click('identity-trigger');
  await wait(200);
  if (!identityTrigger || !identityCardOpens) throw new Error('你身份卡没有渲染');

  // ── 设置 → 模型：服务商列表、LLM 表格、列折叠、按模型开关持久化 ─────────
  await go('#/settings?page=llm', 900);
  const providerRows = count('[data-testid="provider-row"]');
  const fetchModelsButton = Boolean(document.querySelector('[data-testid="refresh-models"]'));
  const addModelButton = Boolean(document.querySelector('[data-testid="add-custom-model"]'));
  const apiKeyOnlyHint = Boolean(document.querySelector('[data-testid="apikey-only"]'));
  const builtinProtected = !document.querySelector('[data-testid="remove-provider"]');

  click('add-custom-model');
  await wait(300);
  const customModelForm = Boolean(document.querySelector('[data-testid="custom-model-id"]'));

  const llmTable = document.querySelector('[data-testid="llm-model-table"]');
  const llmTableScrollable = Boolean(llmTable?.classList.contains('overflow-auto'));
  const llmModelRows = count('[data-testid="llm-model-row"]');
  const llmEnableSwitches = count('[data-testid="llm-model-table"] [role="switch"]');
  const llmColumnsToggle = Boolean(document.querySelector('[data-testid="toggle-columns"]'));
  const llmNameCell = document.querySelector('[data-testid="llm-model-row"] td');
  const llmNameWidth = llmNameCell ? Math.round(llmNameCell.getBoundingClientRect().width) : 0;
  const llmTruncatedNames = [
    ...document.querySelectorAll('[data-testid="llm-model-row"] td:first-child > div:first-child'),
  ].filter((node) => node.scrollWidth > node.clientWidth + 1).length;
  const llmWidthBefore = llmTable ? llmTable.scrollWidth : 0;
  click('toggle-columns');
  await wait(250);
  const llmWidthAfter = llmTable ? llmTable.scrollWidth : 0;
  const llmColumnsExpand = llmWidthAfter > llmWidthBefore;
  const llmHorizontalScroll = llmTable ? llmTable.scrollWidth > llmTable.clientWidth : false;
  click('toggle-columns');
  await wait(200);

  // 按模型开关必须落库：用一个用完就删的自定义服务商，别碰你真实配置。
  const smokeProviderId = 'smoke-llm-switch';
  await window.opc.models.saveProvider({
    id: smokeProviderId,
    name: 'Smoke Switch',
    baseUrl: 'https://smoke.test/v1',
    api: 'openai-completions',
    isCustom: true,
  });
  await window.opc.models.addModel(smokeProviderId, { id: 'smoke/model-1' });
  await window.opc.models.setKey(smokeProviderId, 'smoke-key');
  await go('#/settings?page=appearance', 200);
  await go('#/settings?page=llm', 800);
  [...document.querySelectorAll('[data-testid="provider-row"]')]
    .find((row) => row.textContent?.includes('Smoke Switch'))
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(600);
  const firstSwitch = () => document.querySelector('[data-testid="llm-model-table"] [role="switch"]');
  const switchEnabledBefore = firstSwitch()?.getAttribute('aria-checked') === 'true';
  const llmSwitchUnlocked = firstSwitch()?.hasAttribute('disabled') === false;
  firstSwitch()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(700);
  const storedProviders = await window.opc.models.list();
  const toggled = (storedProviders.find((entry) => entry.id === smokeProviderId)?.models ?? []).find(
    (model) => model.id === 'smoke/model-1',
  );
  const llmSwitchPersists = switchEnabledBefore && toggled?.chatEnabled === false;
  await window.opc.models.removeProvider(smokeProviderId);
  await wait(400);

  // 保存按钮必须是横着的（曾经被挤成方块）。
  const saveButton = [...document.querySelectorAll('button')]
    .map((button) => ({ button, box: button.getBoundingClientRect() }))
    .find(({ button, box }) => button.textContent?.trim() === '保存' && box.height > 0);
  const saveBox = saveButton
    ? { w: Math.round(saveButton.box.width), h: Math.round(saveButton.box.height) }
    : null;

  // ── 设置 → 图片 / 语音 / 决策：每页都得真的渲染出模型表 ─────────────────
  await go('#/settings?page=image', 700);
  const imageRows = count('[data-testid="image-model-row"]');
  const imageGenerateButton = Boolean(document.querySelector('[data-testid="image-generate"]'));
  const imageTableScrollable = Boolean(
    document.querySelector('[data-testid="image-model-row"]')?.closest('.overflow-y-auto'),
  );
  await go('#/settings?page=voice', 700);
  const voiceRows = count('[data-testid="voice-model-row"]');
  await go('#/settings?page=decision', 700);
  const decisionRows = count('[data-testid="decision-model-row"]');
  const decisionRunButton = Boolean(document.querySelector('[data-testid="run-decision"]'));

  // ── 设置 → 行为：工作台的规矩与记忆巩固审计 ───────────────────────────────
  await go('#/settings?page=workspaceRules', 700);
  const factsForm = Boolean(document.querySelector('[data-testid="fact-subject"]'));
  const factRows = count('[data-testid="fact-row"]');
  if (factsForm && factRows === 0) throw new Error('规矩写进去了，规矩页却一行都读不到');
  await go('#/settings?page=consolidation', 700);
  const runRows = count('[data-testid="consolidation-run-row"]');
  const consolidationRuns = await window.opc.memory.consolidationRuns(executor.id);

  // ── 设置 → 上下文压缩：阈值设置独立于规矩和记忆 ───────────────────────────
  await go('#/settings?page=compaction', 900);

  // ── 设置 → 调度：两层过滤可配，而且改完立刻落库 ──────────────────────────
  await go('#/settings?page=triage', 900);
  const triageGroups = count('[role="radiogroup"]');
  const triageDefault = await window.opc.router.getTriage();
  if (triageDefault.fastPath !== 'noise') {
    // 上一轮 smoke 可能把它留在名单模式（下面会改回去，这里只是兜底）。
    await window.opc.router.setTriage({ fastPath: 'noise' });
  }
  // 切到"只放行下列来源"：来源芯片必须出现，说明条件渲染是真的在跑。
  const triageRadios = [
    ...(document.querySelectorAll('[role="radiogroup"]')[0]?.querySelectorAll('[role="radio"]') ?? []),
  ];
  triageRadios[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(500);
  const triageSources = count('[data-testid^="triage-source-"]');
  const triageSwitched = (await window.opc.router.getTriage()).fastPath;
  if (triageSwitched !== 'allowlist') throw new Error('调度页切了模式却没落库');
  triageRadios[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(500);
  const triageRestored = (await window.opc.router.getTriage()).fastPath;
  if (triageRestored !== 'noise') throw new Error('调度页改不回默认策略');

  // 思考档位必须来自 pi 的 catalog（不是前端猜的默认三档）。
  const catalogForThinking = await window.opc.models.getCatalog();
  const thinkingSample = catalogForThinking
    .flatMap((provider) => provider.models)
    .find((model) => model.type === 'chat' && model.reasoning);
  const catalogThinkingLevels = thinkingSample?.thinkingLevels?.length ?? 0;
  if (catalogThinkingLevels === 0) throw new Error('catalog 没有带思考档位');

  // Router 的模型档必须在这一页可选：没有它，`default.router` 就只能靠改库。
  // 触发器现在是一个按钮（点开是模态列表），不再是原生 select。
  const triageModelPicker = Boolean(document.querySelector('[data-testid="triage-router-model"]'));
  if (!triageModelPicker) throw new Error('调度页没有 Router 模型入口');
  // 点开必须真的出现模态（不是被滚动容器裁掉的下拉浮层），Esc 能关掉。
  document
    .querySelector('[data-testid="triage-router-model"]')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(400);
  const triagePickerOpen = Boolean(document.querySelector('[data-testid="model-picker"]'));
  if (!triagePickerOpen) throw new Error('模型选择器没有打开模态');
  const triagePickerRows = count('[data-testid="model-picker-row"]');
  const triageThinkingButtons = count(
    '[data-testid="model-picker-row"] button[aria-haspopup="listbox"]',
  );
  // 悬停后才出现的档位控件，也要能点开成选项列表。
  let triageLevelMenuOpen = false;
  if (triageThinkingButtons > 0) {
    document
      .querySelector('[data-testid="model-picker-row"] button[aria-haspopup="listbox"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(300);
    triageLevelMenuOpen = Boolean(document.querySelector('[data-testid="model-picker-levels"]'));
    if (!triageLevelMenuOpen) throw new Error('思考档位菜单没有打开');
  }
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await wait(300);
  const triagePickerClosed = !document.querySelector('[data-testid="model-picker"]');
  if (!triagePickerClosed) throw new Error('模型选择器的 Esc 没有关掉模态');

  // ── 能力页：四个 tab 都在，且切换是 URL 决定的 ──────────────────────────
  await go('#/skills', 900);
  const capabilityTabs = count('[role="tablist"] [role="tab"]');
  if (capabilityTabs !== 4) throw new Error('能力页应有 4 个 tab，实际 ' + capabilityTabs);
  const tabButtons = [...document.querySelectorAll('[role="tablist"] [role="tab"]')];
  tabButtons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(500);
  const toolsTabSelected =
    [...document.querySelectorAll('[role="tablist"] [role="tab"]')][1]?.getAttribute('aria-selected') ===
    'true';
  await go('#/skills?tab=skills', 700);
  const skillsTabSelected =
    [...document.querySelectorAll('[role="tablist"] [role="tab"]')][2]?.getAttribute('aria-selected') ===
    'true';
  await go('#/skills?tab=mcp', 700);
  // tab 标签本身就写着 MCP，所以用 URL 决定的选中态来判断面板切换，不读文案。
  const mcpTabSelected =
    [...document.querySelectorAll('[role="tablist"] [role="tab"]')][3]?.getAttribute('aria-selected') ===
    'true';

  // ── 主页：对话是唯一的人机入口，旧 attention 深链接会回到这里 ────────────
  await go('#/chat', 800);
  const attentionHeading = document.querySelector('h1')?.textContent ?? null;
  const goalForm = Boolean(document.querySelector('input, textarea'));

  const diagnostics = await window.opc.diagnostics.report();
  return {
    hasBridge,
    title: document.title,
    shell: document.documentElement.dataset.shell,
    platform: document.documentElement.dataset.platform,
    theme: document.documentElement.dataset.theme,
    heading: document.querySelector('h1')?.textContent ?? null,
    rendererRequire: typeof window.require,

    // 执行体 / 工作线
    executor: executorShape,
    workersIsArray: Array.isArray(workers),
    threadCount: threads.length,
    emptyGoalRejected,
    storedTask: {
      issueKey: stored.issueKey ?? null,
      workerId: stored.workerId ?? null,
      hasThread: Boolean(stored.threadId),
    },
    traceRows: traceRows.length,
    task: finishedTask
      ? {
          status: finishedTask.status,
          verdict: finishedTask.acceptance?.verdict ?? null,
          artifacts: finishedTask.artifacts.length,
          exitCode: finishedTask.acceptance?.evidence.exitCode ?? null,
        }
      : null,
    cardVisible,

    // 聊天
    conversationId,
    conversations: opening.conversations.length,
    messagesBefore,
    messagesAfter,
    userVerdictButtons,

    // 能力清单
    capabilityShape,
    diagnosticsOk: diagnostics.probes.every((p) => p.status === 'ok'),

    // issues
    issueRows,
    issueKeyLooksRight,
    issueDetailOpen,
    issuePrioritySelect,
    issueFilteredRows,
    issuePriorityShown,
    issueColumns,
    issueCards,
    issueRefusalShown,
    issueTimelineBars,
    issueBurndown,
    issuePeopleRows,
    issueBulkBar,

    // 聊天页 / 身份卡
    identityTrigger,
    identityCardOpens,

    // 设置
    providerRows,
    fetchModelsButton,
    addModelButton,
    apiKeyOnlyHint,
    customModelForm,
    builtinProtected,
    llmTableScrollable,
    llmModelRows,
    llmEnableSwitches,
    llmColumnsToggle,
    llmColumnsExpand,
    llmHorizontalScroll,
    llmNameWidth,
    llmTruncatedNames,
    llmSwitchPersists,
    llmSwitchUnlocked,
    saveBox,
    imageRows,
    imageGenerateButton,
    imageTableScrollable,
    voiceRows,
    decisionRows,
    decisionRunButton,
    factsForm,
    factRows,
    runRows,
    consolidationRunRows: Array.isArray(consolidationRuns) ? consolidationRuns.length : -1,
    triageGroups,
    triageSources,
    triageRestored,
    triageModelPicker,
    triagePickerOpen,
    triagePickerRows,
    triageThinkingButtons,
    triageLevelMenuOpen,
    catalogThinkingLevels,

    // 能力页 / 注意力页
    capabilityTabs,
    toolsTabSelected,
    skillsTabSelected,
    mcpTabSelected,
    attentionHeading,
    goalForm,
  };
})();
