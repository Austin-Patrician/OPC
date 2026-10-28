(async () => {
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
          const firstConversation = (await window.opc.chat.getSnapshot()).conversations[0];
          let archivedToggle = false;
          let menuArchiveWorks;
          let menuRestoreWorks;
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
          // Settings → 模型 LLM: 拉取模型 / 自定义模型 / OAuth 仅对支持的服务商出现
          location.hash = '#/settings';
          await new Promise((r) => setTimeout(r, 700));
          document
            .querySelector('[data-testid="settings-page-llm"]')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 600));
          const fetchModelsButton = Boolean(document.querySelector('[data-testid="refresh-models"]'));
          const addModelButton = Boolean(document.querySelector('[data-testid="add-custom-model"]'));
          const apiKeyOnlyHint = Boolean(document.querySelector('[data-testid="apikey-only"]'));
          document
            .querySelector('[data-testid="add-custom-model"]')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
          const customModelForm = Boolean(document.querySelector('[data-testid="custom-model-id"]'));
          // A built-in provider must offer no delete action (deletion sits next to
          // Discard for custom providers only).
          const builtinProtected = !document.querySelector('[data-testid="remove-provider"]');
          // Issues: every task carries a human key, rows group by state, detail opens.
          location.hash = '#/issues';
          await new Promise((r) => setTimeout(r, 800));
          const issueRows = document.querySelectorAll('[data-testid="issue-row"]').length;
          const firstRowText = document.querySelector('[data-testid="issue-row"]')?.textContent ?? '';
          const issueKeyLooksRight = /[A-Z0-9]{2,8}-\d+/.test(firstRowText);
          document.querySelector('[data-testid="issue-row"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 400));
          const issueDetailOpen = Boolean(document.querySelector('[data-testid="issue-detail-close"]'));
          document.querySelector('[data-testid="issue-detail-close"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 200));
          document.querySelector('[data-testid="issue-filter-done"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          await new Promise((r) => setTimeout(r, 300));
          const issueFilteredRows = document.querySelectorAll('[data-testid="issue-row"]').length;
          document.querySelector('[data-testid="issue-filter-all"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          document.querySelector('[data-testid="issue-mode-board"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          await new Promise((r) => setTimeout(r, 400));
          // Priority reaches the ledger row after being set through the bridge.
          const sampleTask = (await window.opc.work.listTasks(1))[0];
          if (sampleTask) {
            await window.opc.work.setIssueMeta(sampleTask.id, { priority: 'P0', labels: ['smoke'] });
            document.querySelector('[data-testid="issue-mode-ledger"]')?.dispatchEvent(
              new MouseEvent('click', { bubbles: true }),
            );
            await new Promise((r) => setTimeout(r, 300));
            location.hash = '#/issues';
            await new Promise((r) => setTimeout(r, 500));
            document.querySelector('[data-testid="issue-mode-ledger"]')?.dispatchEvent(
              new MouseEvent('click', { bubbles: true }),
            );
            await new Promise((r) => setTimeout(r, 300));
          }
          // Read the ledger (the board hides these rows), then switch modes.
          const issuePriorityShown = [...document.querySelectorAll('[data-testid="issue-priority"]')].some(
            (node) => node.textContent === 'P0',
          );
          document.querySelector('[data-testid="issue-mode-board"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          await new Promise((r) => setTimeout(r, 300));
          document.querySelector('[data-testid="issue-mode-timeline"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          await new Promise((r) => setTimeout(r, 400));
          const issueTimelineBars = document.querySelectorAll('[data-testid="issue-timeline"] li').length;
          const issueBurndown = Boolean(document.querySelector('[data-testid="issue-burndown"]'));
          document.querySelector('[data-testid="issue-mode-people"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          await new Promise((r) => setTimeout(r, 400));
          const issuePeopleRows = document.querySelectorAll('[data-testid="issue-person-row"]').length;
          // Projects: create through the bridge, then the row + member chip render.
          location.hash = '#/projects';
          await new Promise((r) => setTimeout(r, 700));
          const projectCreateOpen = Boolean(document.querySelector('[data-testid="project-create-open"]'));
          const firstDepartment = (await window.opc.org.list())[0];
          const firstMember = firstDepartment?.members[0];
          if (firstMember) {
            const list = await window.opc.projects.create({
              name: `smoke-${Date.now()}`,
              code: 'SMK-1',
              departmentId: firstDepartment?.id,
            });
            const project = list[0];
            if (project) {
              await window.opc.projects.assign(project.id, firstMember.id, '负责人');
              await window.opc.facts.write({
                scopeType: 'project',
                scopeId: project.id,
                subject: 'smoke-rule',
                object: '项目规定写入可见',
              });
            }
          }
          location.hash = '#/issues';
          await new Promise((r) => setTimeout(r, 300));
          location.hash = '#/projects';
          await new Promise((r) => setTimeout(r, 700));
          const projectRows = document.querySelectorAll('[data-testid="project-row"]').length;
          const projectMembers = document.querySelectorAll('[data-testid="project-member"]').length;
          const projectFactRows = document.querySelectorAll('[data-testid="project-fact-row"]').length;
          // Back to issues so the board assertions below run on the right page.
          location.hash = '#/issues';
          await new Promise((r) => setTimeout(r, 600));

          document.querySelector('[data-testid="issue-mode-ledger"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          await new Promise((r) => setTimeout(r, 300));
          const pickBox = document.querySelector('[data-testid="issue-pick"]');
          pickBox?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
          const issueBulkBar = Boolean(document.querySelector('[data-testid="issue-bulk"]'));
          document.querySelector('[data-testid="issue-mode-board"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          await new Promise((r) => setTimeout(r, 300));
          const issueColumns = document.querySelectorAll('[data-testid^="issue-column-"]').length;
          const issueCards = document.querySelectorAll('[data-testid="issue-card"]').length;
          // A drop that would impersonate the manager must be refused (drag events are
          // synthesised: dragstart on a card, drop on the manager-review column).
          const card = document.querySelector('[data-testid="issue-card"]');
          const reviewColumn = document.querySelector('[data-testid="issue-column-manager-review"]');
          if (card && reviewColumn) {
            card.dispatchEvent(new Event('dragstart', { bubbles: true }));
            // React sets the dragging id through state, so let it commit first.
            await new Promise((r) => setTimeout(r, 200));
            const drop = new Event('drop', { bubbles: true, cancelable: true });
            reviewColumn.dispatchEvent(drop);
          }
          await new Promise((r) => setTimeout(r, 300));
          const issueRefusalShown = Boolean(document.querySelector('[data-testid="issue-notice"]'));
          document.querySelector('[data-testid="issue-mode-ledger"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          await new Promise((r) => setTimeout(r, 300));
          location.hash = '#/settings';
          await new Promise((r) => setTimeout(r, 400));
          // `#/settings` alone lands on 外观; the provider list only exists on the
          // LLM page, so this check has to walk there first.
          document.querySelector('[data-testid="settings-group-models"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 200));
          document.querySelector('[data-testid="settings-page-llm"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 700));
          const providerRows = document.querySelectorAll('[data-testid="provider-row"]').length;
          const providerIcons = document.querySelectorAll('img[src*="provider-icons"]').length;
          const llmTable = document.querySelector('[data-testid="llm-model-table"]');
          const llmTableScrollable = Boolean(llmTable?.classList.contains('overflow-auto'));
          // Per-row enable switches + the collapsible cache columns.
          const llmEnableSwitches = document.querySelectorAll(
            '[data-testid="llm-model-table"] [role="switch"]',
          ).length;
          const llmModelRows = document.querySelectorAll('[data-testid="llm-model-row"]').length;
          const llmColumnsToggle = Boolean(document.querySelector('[data-testid="toggle-columns"]'));
          // How much room the name column actually gets in the default view, and
          // how many names still need the tooltip.
          const llmNameCell = document.querySelector('[data-testid="llm-model-row"] td');
          const llmNameWidth = llmNameCell ? Math.round(llmNameCell.getBoundingClientRect().width) : 0;
          const llmTruncatedNames = [
            ...document.querySelectorAll('[data-testid="llm-model-row"] td:first-child > div:first-child'),
          ].filter((node) => node.scrollWidth > node.clientWidth + 1).length;
          const llmWidthBefore = llmTable ? llmTable.scrollWidth : 0;
          document.querySelector('[data-testid="toggle-columns"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          await new Promise((r) => setTimeout(r, 250));
          const llmWidthAfter = llmTable ? llmTable.scrollWidth : 0;
          const llmColumnsExpand = llmWidthAfter > llmWidthBefore;
          const llmHorizontalScroll = llmTable ? llmTable.scrollWidth > llmTable.clientWidth : false;
          // Restore the folded default so later checks see the same layout a user does.
          document.querySelector('[data-testid="toggle-columns"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          await new Promise((r) => setTimeout(r, 200));

          // The per-row enable switch must persist `chatEnabled`. A throwaway custom
          // provider keeps this off the user's real configuration, and it is deleted
          // again at the end.
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
          document.querySelector('[data-testid="settings-page-appearance"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          await new Promise((r) => setTimeout(r, 200));
          document.querySelector('[data-testid="settings-page-llm"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
          await new Promise((r) => setTimeout(r, 800));
          [...document.querySelectorAll('[data-testid="provider-row"]')]
            .find((row) => row.textContent?.includes('Smoke Switch'))
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 600));
          const firstSwitch = () =>
            document.querySelector('[data-testid="llm-model-table"] [role="switch"]');
          const switchEnabledBefore = firstSwitch()?.getAttribute('aria-checked') === 'true';
          const llmSwitchUnlocked = firstSwitch()?.hasAttribute('disabled') === false;
          firstSwitch()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 700));
          const storedAfterToggle = await window.opc.models.list();
          const toggled = (storedAfterToggle.find((entry) => entry.id === smokeProviderId)?.models ?? []).find(
            (model) => model.id === 'smoke/model-1',
          );
          const llmSwitchPersists = switchEnabledBefore && toggled?.chatEnabled === false;
          await window.opc.models.removeProvider(smokeProviderId);
          await new Promise((r) => setTimeout(r, 400));

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
          // Settings → workspace: 公司事实 list + inline write
          location.hash = '#/settings';
          await new Promise((r) => setTimeout(r, 700));
          document
            .querySelector('[data-testid="settings-page-compaction"]')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 500));
          let factsForm = Boolean(document.querySelector('[data-testid="org-fact-subject"]'));
          await window.opc.facts.write({ scopeType: 'org', subject: 'smoke', object: '公司事实写入可见' });
          location.hash = '#/org';
          await new Promise((r) => setTimeout(r, 300));
          location.hash = '#/settings';
          await new Promise((r) => setTimeout(r, 600));
          document
            .querySelector('[data-testid="settings-page-compaction"]')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 600));
          const factRows = document.querySelectorAll('[data-testid="org-fact-row"]').length;
          const runRows = document.querySelectorAll('[data-testid="consolidation-run-row"]').length;

          // Department rules live in the department dossier (org_fact scope=department).
          let deptFactsForm = false;
          let deptFactRows = 0;
          const dept = (await window.opc.org.list())[0];
          if (dept) {
            // The tree view is the only one with cards; the view choice persists.
            localStorage.setItem('opc.org.view', 'tree');
            location.hash = '#/org';
            await new Promise((r) => setTimeout(r, 800));
            document
              .querySelector('[data-testid="org-view-tree"]')
              ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await new Promise((r) => setTimeout(r, 300));
            document
              .querySelector('[data-testid="org-card"]')
              ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await new Promise((r) => setTimeout(r, 500));
            deptFactsForm = Boolean(document.querySelector('[data-testid="dept-fact-subject"]'));
            await window.opc.facts.write({
              scopeType: 'department',
              scopeId: dept.id,
              subject: 'smoke-dept',
              object: '部门规定写入可见',
            });
            // Re-mount the dossier so the block reloads its list from the service.
            document
              .querySelector('[data-testid="close-detail"]')
              ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await new Promise((r) => setTimeout(r, 300));
            document
              .querySelector('[data-testid="org-card"]')
              ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await new Promise((r) => setTimeout(r, 500));
            deptFactRows = document.querySelectorAll('[data-testid="dept-fact-row"]').length;
          }
          location.hash = '#/org';
          await new Promise((r) => setTimeout(r, 500));
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
            factsForm,
            factRows,
            runRows,
            deptFactsForm,
            deptFactRows,
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
            issueRows,
            issueKeyLooksRight,
            issueDetailOpen,
            issueFilteredRows,
            issuePriorityShown,
            issueTimelineBars,
            projectCreateOpen,
            projectRows,
            projectMembers,
            projectFactRows,
            issueBurndown,
            issuePeopleRows,
            issueBulkBar,
            issueColumns,
            issueCards,
            issueRefusalShown,
            providerRows,
            fetchModelsButton,
            addModelButton,
            apiKeyOnlyHint,
            customModelForm,
            builtinProtected,
            providerIcons,
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
        })()