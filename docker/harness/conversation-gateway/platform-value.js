(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const list = (value) => Array.isArray(value) ? value : [];
  const words = (value) => Array.isArray(value) ? value.join('；') : String(value ?? '');
  const statuses = { available: '可用', partial: '部分可用', 'in-progress': '建设中' };
  const releaseStatuses = { released: '已在注明范围上线', partial: '部分可用', 'in-progress': '建设中' };
  const updateTypes = { new: '新增能力', improved: '体验与能力改进', fixed: '问题修复' };
  const kinds = { tool: '工具', service: '服务', template: '模板' };
  const state = { catalog: null, updates: null, features: [], featureMap: new Map(), roles: new Map(), errors: [], loading: false };
  let focusAfterNavigation = false;

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = words(text);
    if (className) node.className = className;
    return node;
  }

  function link(text, hash, className) {
    const node = element('a', text, className);
    node.href = hash;
    return node;
  }

  function badge(status, release = false) {
    return element('span', (release ? releaseStatuses : statuses)[status] || '状态待补充', `pv-badge pv-badge-${status}`);
  }

  function roleNames(ids) {
    return list(ids).map((id) => state.roles.get(id)?.title || id).join('、');
  }

  function route() {
    const hash = location.hash.slice(1);
    const [view, ...parts] = hash.split('/');
    let id;
    try { id = decodeURIComponent(parts.join('/')); } catch { id = ''; }
    return { view: view || 'overview', id };
  }

  function heading(title, description, kicker) {
    const node = element('header', null, 'pv-section-heading');
    if (kicker) node.append(element('p', kicker, 'pv-eyebrow'));
    node.append(element('h2', title));
    if (description) node.append(element('p', description));
    return node;
  }

  function section(title, description, kicker) {
    const node = element('section', null, 'pv-section');
    if (kicker) node.append(element('p', kicker, 'pv-eyebrow'));
    node.append(element('h3', title));
    if (description) node.append(element('p', description, 'pv-muted'));
    return node;
  }

  function table(headers, rows, label) {
    const wrap = element('div', null, 'pv-table-scroll');
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', label);
    const node = element('table', null, 'pv-table');
    node.setAttribute('aria-label', label);
    const head = element('thead');
    const headRow = element('tr');
    headers.forEach((text) => { const cell = element('th', text); cell.scope = 'col'; headRow.append(cell); });
    head.append(headRow);
    const body = element('tbody');
    rows.forEach((row) => {
      const line = element('tr');
      row.forEach((value, index) => {
        const cell = element(index === 0 ? 'th' : 'td');
        cell.setAttribute('data-label', headers[index]);
        if (index === 0) cell.scope = 'row';
        if (value && typeof value === 'object' && value.nodeType) cell.append(value);
        else cell.textContent = words(value);
        line.append(cell);
      });
      body.append(line);
    });
    node.append(head, body);
    wrap.append(node);
    return wrap;
  }

  function definition(node, title, text) {
    if (!words(text)) return;
    const row = element('div');
    row.append(element('dt', title), element('dd', text));
    node.append(row);
  }

  function empty(title, help, reset) {
    const node = element('div', null, 'pv-empty');
    node.append(element('h3', title), element('p', help));
    if (reset) {
      const button = element('button', '清除筛选', 'secondary-button');
      button.type = 'button';
      button.addEventListener('click', reset);
      node.append(button);
    }
    return node;
  }

  function featureUrl(id) { return `#feature/${encodeURIComponent(id)}`; }
  function categoryUrl(id) { return `#category/${encodeURIComponent(id)}`; }
  function groupUrl(id) { return `#group/${encodeURIComponent(id)}`; }

  function featureNode(entry, headingTag = 'h3') {
    const { feature, category, group } = entry;
    const node = element('article', null, 'pv-feature');
    const meta = element('div', null, 'pv-feature-meta');
    meta.append(badge(feature.status), element('span', `约略上线：${feature.since || '时间待补充'}`));
    node.append(meta, element(headingTag, feature.title), element('p', feature.summary, 'pv-feature-lead'));
    const comparison = element('dl', null, 'pv-comparison');
    definition(comparison, '以前需要自己处理', feature.before);
    definition(comparison, '平台具体做了什么', feature.after);
    node.append(comparison);
    if (list(feature.benefits).length) {
      node.append(element('p', '你少做了哪些事', 'pv-benefits-title'));
      const benefits = element('ul', null, 'pv-benefits');
      feature.benefits.forEach((text) => benefits.append(element('li', text)));
      node.append(benefits);
    }
    const boundary = element('aside', null, 'pv-boundary');
    boundary.append(element('strong', '目前的限制，以及多出的步骤'));
    if (list(feature.limitations).length) {
      const items = element('ul');
      feature.limitations.forEach((text) => items.append(element('li', text)));
      boundary.append(items);
    } else boundary.append(element('p', '适用边界尚未登记。'));
    node.append(boundary);
    const foot = element('div', null, 'pv-feature-foot');
    foot.append(element('span', `受益角色：${roleNames(feature.roles) || '以具体使用场景为准'}`), link('查看此项完整说明', featureUrl(feature.id)));
    node.append(foot);
    node.dataset.featureId = feature.id;
    node.setAttribute('aria-label', `${category.title}，${group.title}，${feature.title}`);
    return node;
  }

  function overview() {
    const fragment = document.createDocumentFragment();
    fragment.append(heading('从接上 AI，到把开发中的麻烦逐项接过来', '最初，把会写代码的 AI 和现成的企业应用底座接起来，就可以开始做业务。后面的建设，是把项目之间、人员之间、开发过程和上线交付中需要反复操心的事，一项项整理好。'));

    if (list(state.catalog.journey).length) {
      const stories = element('ol', null, 'pv-story-list');
      state.catalog.journey.forEach((story, index) => {
        const item = element('li', null, 'pv-story');
        const meta = element('p', `${String(index + 1).padStart(2, '0')} · ${story.period}`, 'pv-story-meta');
        item.append(meta, element('h3', story.title));
        const comparison = element('dl', null, 'pv-story-comparison');
        definition(comparison, '原来要自己操心', story.problem);
        definition(comparison, '现在少了哪些事', story.result);
        item.append(comparison);
        const example = element('div', null, 'pv-story-example');
        example.append(element('strong', '举个例子'), element('p', story.example));
        item.append(example);
        const detail = element('details', null, 'pv-explain-more');
        detail.append(element('summary', '为此，平台具体做了什么'));
        const work = element('ul');
        list(story.changes).forEach((text) => work.append(element('li', text)));
        detail.append(work);
        const related = element('div', null, 'pv-related');
        list(story.featureIds).filter((id) => state.featureMap.has(id)).forEach((id) => related.append(link(state.featureMap.get(id).feature.title, featureUrl(id))));
        detail.append(related);
        item.append(detail);
        stories.append(item);
      });
      fragment.append(stories);
    }

    const workload = section('投入的工作，省在哪些反复发生的事情上', '下面按工作发生的次数看价值：平台把通用准备提前做好，在条件适用时重复使用。');
    workload.append(table(['什么时候会重复', '没有这些建设时，要自己做', '平台替团队减少的工作'], [
      ['每新建一个项目', '重新搭开发环境、接基础功能、检查项目之间有没有混用配置和数据。', '从准备好的公共基础开始，在独立项目环境里做客户需要的差异。'],
      ['每换一个人或新开一项任务', '交代文件放在哪里，防止改到别人的代码，重新说明上次做到哪。', '提供各自的工作空间，保留任务中的资料、代码和对话，方便继续。'],
      ['每次让 AI 生成代码或页面', '重复强调写法和页面规则，再把不一致的按钮、表单和处理方式改回来。', '复用已整理的要求和公共组件，减少相同要求的重复交代与生成后的统一修改。'],
      ['每次检查、打包和发布', '找命令、装依赖、处理下载问题、串联步骤，再确认发布的是哪一版。', '复用兼容的准备成果，通过已经连接好的步骤完成必要检查和发布。']
    ], '哪些重复工作被平台承担'));
    workload.append(element('p', '这些工作少做多少次，可以按实际项目记录核算。节省工时要扣除新增检查和维护的人工投入；费用与 Token 按实际使用记录核算。目前没有足够的对照数据，不能报统一节省比例。', 'pv-small-note'));
    fragment.append(workload);

    const waiting = section('为什么有了平台，有时反而要多等一步？', 'AI 写出代码，只完成了开发中的一部分。平台还要处理能不能一起用、改得对不对、会不会影响别人，以及能不能交付。多出的时间应该能说清在做哪件事。');
    waiting.append(table(['你会看到的步骤', '多做这一步，是为了什么', '应该做到什么程度'], [
      ['先把需求说清楚', '例如谁能提交、谁来审批、哪些内容必须填写。先确认，可以少在做完后整批返工。', '只确认本次真正影响结果的问题，已经说清的内容不反复问。'],
      ['先准备独立工作环境', '让你的修改不碰到别人的任务，也不把一个项目的数据或设置带进另一个项目。', '首次准备可能需要等待；可复用的环境和依赖应复用。'],
      ['修改后做相关检查', '提前发现页面、规则或代码的问题，减少把排查和补救留给测试、交付或客户。', '只检查本次涉及的内容，仍然有效的结果不反复重跑。'],
      ['同一项目不能同时发布', '两个人同时改正在运行的系统，可能相互覆盖。一次完成后再处理下一次。', '告诉用户谁正在发布、自己的操作处于什么状态，避免没有反馈地等待。']
    ], '必要步骤与等待原因'));
    waiting.append(element('p', '重复下载同一份依赖、没有变化却反复检查、长时间没有反馈、已经完成还要求重来，都属于要继续改进的问题。不能因为平台提供了更多能力，就把这些体验问题说成必要成本。', 'pv-note'));
    fragment.append(waiting);

    if (list(state.catalog.roles).length) {
      const roles = section('团队里的每个角色，少了哪些事、获得什么能力');
      const detail = element('details', null, 'pv-explain-more pv-reading-detail');
      detail.append(element('summary', '展开查看：产品、设计、开发、测试、运维、交付、销售和负责人'));
      detail.append(table(['团队角色', '原来需要操心', '现在可以怎样工作', '仍需要人来判断'], state.catalog.roles.map((role) => [role.title, role.need, role.value, role.responsibility]), '团队角色与价值'));
      roles.append(detail);
      fragment.append(roles);
    }

    if (list(state.catalog.phases).length) {
      const phases = section(`用 AI 做一个功能，${state.catalog.phases.length} 个阶段分别做什么？`, '把需求说清 → 约定业务和数据 → 设计数据库 → 设计页面 → 实现后台 → 实现页面 → 配好菜单权限 → 连起来验收。简单修改按实际范围处理，发布在完成必要检查后另行执行。');
      const detail = element('details', null, 'pv-explain-more pv-reading-detail');
      detail.append(element('summary', '展开每个阶段：要提供什么、平台协助什么、最后得到什么'));
      const phaseList = element('ol', null, 'pv-phase-list');
      state.catalog.phases.forEach((phase) => {
        const item = element('li', null, 'pv-phase');
        const content = element('div');
        content.append(element('h4', phase.title));
        const description = element('dl');
        definition(description, '你先说明', phase.userProvides);
        definition(description, '平台协助', phase.platformDoes);
        definition(description, '这一步做完得到', phase.userGets);
        content.append(description);
        if (phase.boundary) content.append(element('p', phase.boundary, 'pv-small-note'));
        item.append(content);
        phaseList.append(item);
      });
      detail.append(phaseList);
      phases.append(detail);
      fragment.append(phases);
    }

    const coverage = section('需要逐项查阅时，看这里的完整功能清单', '左侧按一级、二级、具体功能逐层展开，也可以直接搜索。每项都说明以前的麻烦、平台具体做的工作、使用收益、大概上线时间和目前限制。');
    coverage.append(table(['想了解哪方面', '这一类主要讲什么'], state.catalog.categories.map((category) => [link(category.title, categoryUrl(category.id)), category.summary]), '详细功能分类'));
    const counts = element('div', null, 'pv-stats');
    const values = [[state.features.length, '已登记的能力'], ...Object.entries(statuses).map(([status, label]) => [state.features.filter(({ feature }) => feature.status === status).length, label])];
    values.forEach(([count, label]) => { const item = element('div', null, 'pv-stat'); item.append(element('strong', count), element('span', label)); counts.append(item); });
    coverage.append(counts, element('p', '按本页具体功能统计。部分能力仍在完善，不代表所有旧项目都已经完成更新。数量用于查阅范围，不用于换算工时。', 'pv-small-note'));
    fragment.append(coverage);

    if (list(state.catalog.tools).length) {
      const tools = section('想核对具体封装了什么，再看工具清单');
      const statistics = element('div', null, 'pv-tool-stats');
      Object.entries(kinds).forEach(([kind, label]) => {
        const item = element('span');
        item.append(element('strong', state.catalog.tools.filter((tool) => tool.kind === kind).length), document.createTextNode(`项${label}`));
        statistics.append(item);
      });
      tools.append(statistics);
      const detail = element('details', null, 'pv-tool-detail pv-explain-more');
      detail.append(element('summary', '展开具体名称及用途，日常使用不必记住这些名字'));
      detail.append(table(['名称', '类型', '替使用者处理什么', '状态'], state.catalog.tools.map((tool) => [tool.name, kinds[tool.kind] || '其他', tool.purpose, badge(tool.status)]), '工具服务与模板明细'));
      tools.append(detail, element('p', '这里只列有依据的代表性工具、服务和模板，不按文件或脚本数量累加。', 'pv-small-note'));
      fragment.append(tools);
    }
    fragment.append(link('看最近上线和修复了什么 →', '#updates', 'pv-next-reading'));
    return fragment;
  }

  function filteredFeatures() {
    const query = $('pv-search').value.trim().toLocaleLowerCase();
    const status = $('pv-status-filter').value;
    return state.features.filter(({ feature, category, group }) => {
      if (status !== 'all' && feature.status !== status) return false;
      const content = [category.title, category.summary, group.title, feature.title, feature.summary, feature.before, feature.after, ...list(feature.benefits), ...list(feature.limitations), roleNames(feature.roles)].join(' ').toLocaleLowerCase();
      return !query || query.split(/\s+/).every((term) => content.includes(term));
    });
  }

  function renderTree(entries) {
    const tree = $('pv-tree');
    tree.replaceChildren();
    const current = route();
    const overviewLink = link('先看平台做了哪些事', '#overview', 'pv-tree-overview');
    if (current.view === 'overview' && !hasFilters()) overviewLink.setAttribute('aria-current', 'page');
    tree.append(overviewLink);
    const visible = new Set(entries.map(({ feature }) => feature.id));
    state.catalog.categories.forEach((category) => {
      if (!category.groups.some((group) => group.features.some((feature) => visible.has(feature.id)))) return;
      const detail = element('details', null, 'pv-tree-category');
      const containsCurrent = current.view === 'category' && current.id === category.id || category.groups.some((group) => current.view === 'group' && current.id === group.id || group.features.some((feature) => current.view === 'feature' && current.id === feature.id));
      detail.open = containsCurrent || hasFilters();
      detail.append(element('summary', category.title));
      const categoryLink = link('查看这一类的全部能力', categoryUrl(category.id), 'pv-tree-category-link');
      if (current.view === 'category' && current.id === category.id && !hasFilters()) categoryLink.setAttribute('aria-current', 'page');
      detail.append(categoryLink);
      category.groups.forEach((group) => {
        const features = group.features.filter((feature) => visible.has(feature.id));
        if (!features.length) return;
        const groupDetail = element('details', null, 'pv-tree-group');
        groupDetail.open = containsCurrent || hasFilters();
        groupDetail.append(element('summary', group.title));
        const links = element('ul', null, 'pv-tree-links');
        features.forEach((feature) => {
          const item = element('li');
          const target = link(feature.title, featureUrl(feature.id));
          if (current.view === 'feature' && current.id === feature.id && !hasFilters()) target.setAttribute('aria-current', 'page');
          item.append(target);
          links.append(item);
        });
        groupDetail.append(links);
        detail.append(groupDetail);
      });
      tree.append(detail);
    });
  }

  function hasFilters() { return Boolean($('pv-search').value.trim()) || $('pv-status-filter').value !== 'all'; }

  function clearCatalogFilters() {
    $('pv-search').value = '';
    $('pv-status-filter').value = 'all';
  }

  function breadcrumb(entry) {
    const node = element('nav', null, 'pv-breadcrumb');
    node.setAttribute('aria-label', '当前功能位置');
    node.append(link('功能概览', '#overview'), element('span', '/'), link(entry.category.title, categoryUrl(entry.category.id)), element('span', '/'), link(entry.group.title, groupUrl(entry.group.id)));
    return node;
  }

  function renderCatalog() {
    const content = $('pv-catalog-content');
    content.replaceChildren();
    if (!state.catalog) { content.append(empty('功能清单暂未载入', '请使用上方的重新加载按钮读取内容。')); return; }
    const entries = filteredFeatures();
    $('pv-search-status').textContent = hasFilters() ? `找到 ${entries.length} 项能力` : `${state.catalog.categories.length} 个一级分类 · ${state.features.length} 项能力`;
    renderTree(entries);
    if (hasFilters()) {
      content.append(heading('查找相关能力', `当前找到 ${entries.length} 项。可继续按关键词或状态筛选，也可在左侧进入单项完整说明。`));
      if (!entries.length) content.append(empty('没有找到符合条件的能力', '可尝试“项目”“发布”“测试”等工作用语，或清除状态筛选。', () => { clearCatalogFilters(); renderCatalog(); }));
      entries.forEach((entry) => { content.append(breadcrumb(entry), featureNode(entry)); });
      return;
    }
    const current = route();
    if (current.view === 'feature') {
      const entry = state.featureMap.get(current.id);
      if (entry) { content.append(breadcrumb(entry), featureNode(entry, 'h2')); return; }
    } else if (current.view === 'category' || current.view === 'group') {
      const matching = state.features.filter((entry) => current.view === 'category' ? entry.category.id === current.id : entry.group.id === current.id);
      if (matching.length) {
        const first = matching[0];
        content.append(breadcrumb(first), heading(current.view === 'category' ? first.category.title : first.group.title, first.category.summary));
        let lastGroup = '';
        matching.forEach((entry) => {
          if (lastGroup !== entry.group.id && current.view === 'category') {
            content.append(element('h3', entry.group.title, 'pv-group-heading'));
            lastGroup = entry.group.id;
          }
          content.append(featureNode(entry, current.view === 'category' ? 'h4' : 'h3'));
        });
        return;
      }
    } else { content.append(overview()); return; }
    content.append(empty('没有找到这项能力', '链接所指的条目可能已调整。请从左侧目录查找当前功能。'), link('返回建设过程说明', '#overview'));
  }

  function todayInShanghai() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const date = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${date.year}-${date.month}-${date.day}`;
  }

  function renderUpdates() {
    const content = $('pv-updates-content');
    content.replaceChildren();
    if (!state.updates) { content.append(empty('更新记录暂未载入', '请使用上方的重新加载按钮读取内容。')); return; }
    const type = $('pv-update-type').value;
    const date = $('pv-update-date').value;
    const updates = state.updates.updates.filter((update) => (type === 'all' || update.type === type) && (date === 'all' || update.date === date));
    const today = todayInShanghai();
    const todayCount = state.updates.updates.filter((update) => update.date === today).length;
    $('pv-today-note').textContent = todayCount ? `今天（${today}）已登记 ${todayCount} 条更新，具体上线范围见各条说明。` : `今天（${today}）暂无已登记的新发布记录。此处展示已收录的更新，不据此判断今天是否发生过发布。`;
    $('pv-update-summary').textContent = `显示 ${updates.length} 条更新 · ${new Set(updates.map((update) => update.date)).size} 个日期`;
    if (!updates.length) {
      content.append(empty('当前条件下没有更新记录', '可以选择其他日期或查看全部类型。', () => { $('pv-update-type').value = 'all'; $('pv-update-date').value = 'all'; renderUpdates(); }));
      return;
    }
    const grouped = new Map();
    updates.forEach((update) => { if (!grouped.has(update.date)) grouped.set(update.date, []); grouped.get(update.date).push(update); });
    [...grouped.keys()].sort().reverse().forEach((day) => {
      const daySection = element('section', null, 'pv-update-day');
      const dateHeading = element('h3');
      const time = element('time', day);
      time.dateTime = day;
      dateHeading.append(time);
      const records = element('div', null, 'pv-day-records');
      grouped.get(day).forEach((update) => {
        const article = element('article', null, 'pv-update');
        article.dataset.updateId = update.id;
        const meta = element('div', null, 'pv-update-meta');
        meta.append(element('span', updateTypes[update.type] || '更新', 'pv-update-type'), badge(update.status, true));
        article.append(meta, element('h4', update.title));
        const body = element('dl', null, 'pv-update-body');
        definition(body, '此前的问题', update.before);
        definition(body, '这次的变化', update.after);
        definition(body, '你少做哪些事', update.benefit);
        article.append(body, element('p', `适用范围：${update.scope || '范围待补充'}`, 'pv-update-scope'));
        if (list(update.roles).length) article.append(element('p', `受益角色：${roleNames(update.roles)}`, 'pv-update-scope'));
        const related = list(update.featureIds).filter((id) => state.featureMap.has(id));
        if (related.length) {
          const links = element('div', null, 'pv-related');
          links.append(element('span', '关联能力'));
          related.forEach((id) => links.append(link(state.featureMap.get(id).feature.title, featureUrl(id))));
          article.append(links);
        }
        records.append(article);
      });
      daySection.append(dateHeading, records);
      content.append(daySection);
    });
  }

  function activateView() {
    const updates = route().view === 'updates';
    $('pv-catalog-panel').hidden = updates;
    $('pv-updates-panel').hidden = !updates;
    $('pv-catalog-tab').setAttribute('aria-selected', String(!updates));
    $('pv-updates-tab').setAttribute('aria-selected', String(updates));
    $('pv-catalog-tab').tabIndex = updates ? -1 : 0;
    $('pv-updates-tab').tabIndex = updates ? 0 : -1;
    const asOf = updates ? state.updates?.asOf : state.catalog?.asOf;
    $('pv-as-of').textContent = asOf ? `内容更新至 ${asOf}` : '内容尚未载入';
    document.title = `${updates ? '最近更新' : '平台能力'} · 交付隔离台`;
    if (updates) renderUpdates(); else renderCatalog();
    if (focusAfterNavigation) {
      focusAfterNavigation = false;
      $(updates ? 'pv-updates-panel' : 'pv-catalog-content').focus();
    }
  }

  function navigate(hash) {
    clearCatalogFilters();
    focusAfterNavigation = true;
    if (location.hash === hash) activateView();
    else location.hash = hash;
  }

  async function readContent(file) {
    const response = await fetch(`/forge-gateway/assets/${file}`, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('登录状态已失效或无权访问，请返回交付隔离台确认登录后重试。');
      throw new Error('内容暂时无法读取，请稍后重试。');
    }
    try { return await response.json(); } catch { throw new Error('内容暂时无法读取，请返回交付隔离台确认登录后重试。'); }
  }

  function indexCatalog(catalog) {
    if (!catalog || !Array.isArray(catalog.categories) || catalog.categories.some((category) => !Array.isArray(category.groups) || category.groups.some((group) => !Array.isArray(group.features)))) throw new Error('功能清单格式暂不可用，请稍后重试。');
    state.catalog = catalog;
    state.features = catalog.categories.flatMap((category) => category.groups.flatMap((group) => group.features.map((feature) => ({ feature, category, group }))));
    state.featureMap = new Map(state.features.map((entry) => [entry.feature.id, entry]));
    state.roles = new Map(list(catalog.roles).map((role) => [role.id, role]));
  }

  function indexUpdates(updates) {
    if (!updates || !Array.isArray(updates.updates)) throw new Error('更新记录格式暂不可用，请稍后重试。');
    state.updates = updates;
    const picker = $('pv-update-date');
    const previous = picker.value;
    picker.replaceChildren();
    const all = element('option', '全部日期');
    all.value = 'all';
    picker.append(all);
    [...new Set(updates.updates.map((update) => update.date))].sort().reverse().forEach((date) => {
      const option = element('option', date);
      option.value = date;
      picker.append(option);
    });
    picker.value = [...picker.options].some((option) => option.value === previous) ? previous : 'all';
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    state.errors = [];
    $('pv-error').hidden = true;
    $('pv-load-state').hidden = false;
    $('pv-retry').disabled = true;
    $('pv-catalog-panel').setAttribute('aria-busy', 'true');
    $('pv-updates-panel').setAttribute('aria-busy', 'true');
    const results = await Promise.allSettled([
      state.catalog ? Promise.resolve() : readContent('platform-catalog.json').then(indexCatalog),
      state.updates ? Promise.resolve() : readContent('platform-updates.json').then(indexUpdates)
    ]);
    results.forEach((result, index) => { if (result.status === 'rejected') state.errors.push(`${index === 0 ? '功能清单' : '最近更新'}：${result.reason.message || '读取失败，请重试。'}`); });
    $('pv-load-state').hidden = true;
    $('pv-error').hidden = !state.errors.length;
    $('pv-error-message').textContent = state.errors.join(' ');
    $('pv-retry').disabled = false;
    $('pv-catalog-panel').setAttribute('aria-busy', 'false');
    $('pv-updates-panel').setAttribute('aria-busy', 'false');
    state.loading = false;
    activateView();
  }

  $('pv-catalog-tab').addEventListener('click', () => navigate('#overview'));
  $('pv-updates-tab').addEventListener('click', () => navigate('#updates'));
  [$('pv-catalog-tab'), $('pv-updates-tab')].forEach((tab) => {
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const showUpdates = event.key === 'End' || (event.key !== 'Home' && tab.id === 'pv-catalog-tab');
      const target = $(showUpdates ? 'pv-updates-tab' : 'pv-catalog-tab');
      navigate(showUpdates ? '#updates' : '#overview');
      target.focus();
    });
  });
  $('pv-search').addEventListener('input', (event) => { if (!event.isComposing) renderCatalog(); });
  $('pv-search').addEventListener('compositionend', renderCatalog);
  $('pv-status-filter').addEventListener('change', renderCatalog);
  $('pv-update-type').addEventListener('change', renderUpdates);
  $('pv-update-date').addEventListener('change', renderUpdates);
  $('pv-updates-filters').addEventListener('submit', (event) => event.preventDefault());
  $('pv-updates-reset').addEventListener('click', () => { $('pv-update-type').value = 'all'; $('pv-update-date').value = 'all'; renderUpdates(); });
  $('pv-retry').addEventListener('click', load);
  document.addEventListener('click', (event) => {
    const anchor = event.target.closest('a[href^="#"]');
    if (!anchor || anchor.getAttribute('href') === '#pv-main' || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(anchor.getAttribute('href'));
    if (window.matchMedia('(max-width: 800px)').matches && anchor.closest('#pv-tree')) $('pv-navigation').open = false;
  });
  window.addEventListener('hashchange', () => { clearCatalogFilters(); activateView(); });
  if (window.matchMedia('(max-width: 800px)').matches) $('pv-navigation').open = false;
  load();
})();
