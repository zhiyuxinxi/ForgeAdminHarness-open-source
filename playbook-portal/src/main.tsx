import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import MiniSearch from "minisearch";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  categoryLabel,
  defaultDocumentPath,
  documentTree,
  documents,
  documentsByPath,
  resolveMarkdownLink,
  stageLandingPath,
  stages
} from "./content";
import type { PlaybookDocument, SearchResult, TreeNode } from "./types";
import "./styles.css";

const kindLabels: Record<PlaybookDocument["kind"], string> = {
  guide: "操作说明",
  template: "可复制任务单",
  recipe: "黄金配方",
  evidence: "验证证据",
  index: "目录入口",
  meta: "维护规则"
};

function tokenise(text: string): string[] {
  const normalized = text.toLocaleLowerCase("zh-CN");
  const tokens = normalized.match(/[a-z0-9][a-z0-9_.-]*|[\u3400-\u9fff]+/g) ?? [];
  return tokens.flatMap((token) => {
    if (!/^[\u3400-\u9fff]+$/.test(token)) return [token];
    const characters = Array.from(token);
    if (characters.length === 1) return characters;
    return characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1]}`);
  });
}

const searchIndex = new MiniSearch<SearchResult>({
  fields: ["title", "summary", "plainText", "headings", "path"],
  storeFields: ["id", "path", "title", "summary", "category", "kind"],
  searchOptions: { boost: { title: 5, headings: 2.5, summary: 2 }, combineWith: "AND", prefix: true },
  tokenize: tokenise
});

searchIndex.addAll(documents.map((document) => ({
  id: document.id,
  path: document.path,
  title: document.title,
  summary: document.summary,
  category: document.category,
  kind: document.kind,
  plainText: document.plainText,
  headings: document.headings.join(" ")
})));

function documentUrl(path: string, query = ""): string {
  const params = new URLSearchParams();
  params.set("doc", path);
  if (query.trim()) params.set("q", query.trim());
  return `${window.location.pathname}?${params.toString()}`;
}

function initialUrlState(): { path: string; query: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    path: params.get("doc") ?? defaultDocumentPath ?? "",
    query: params.get("q") ?? ""
  };
}

function ancestorFolders(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function countDocuments(nodes: TreeNode[]): number {
  return nodes.reduce((count, node) => count + (node.type === "document" ? 1 : countDocuments(node.children)), 0);
}

function TreeItem({
  node,
  selectedPath,
  expanded,
  onToggle,
  onSelect
}: {
  node: TreeNode;
  selectedPath: string;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  if (node.type === "document") {
    const active = node.document.path === selectedPath;
    return (
      <li>
        <button
          type="button"
          className={`tree-document ${active ? "is-active" : ""}`}
          aria-current={active ? "page" : undefined}
          onClick={() => onSelect(node.document.path)}
        >
          <span className={`document-kind-dot kind-${node.document.kind}`} aria-hidden="true" />
          <span>{node.label}</span>
        </button>
      </li>
    );
  }

  const open = expanded.has(node.key);
  const childCount = countDocuments(node.children);
  return (
    <li className="tree-folder">
      <button type="button" className="tree-folder-trigger" aria-expanded={open} onClick={() => onToggle(node.key)}>
        <span className="folder-chevron" aria-hidden="true">›</span>
        <span>{node.label}</span>
        <span className="folder-count">{childCount}</span>
      </button>
      {open && (
        <ul>
          {node.children.map((child) => (
            <TreeItem key={child.key} node={child} selectedPath={selectedPath} expanded={expanded} onToggle={onToggle} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

function textFromReactNode(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromReactNode).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return textFromReactNode(node.props.children);
  return "";
}

function headingId(children: React.ReactNode): string {
  return textFromReactNode(children)
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
}

function copyFallback(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.inset = "-9999px auto auto -9999px";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (!copyFallback(text)) throw new Error("当前浏览器不支持自动复制");
}

function downloadMarkdown(document: PlaybookDocument): void {
  const blob = new Blob([document.markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = document.path.split("/").at(-1) ?? `${document.title}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function App() {
  const initial = useMemo(initialUrlState, []);
  const [selectedPath, setSelectedPath] = useState(initial.path);
  const [query, setQuery] = useState(initial.query);
  const deferredQuery = useDeferredValue(query.trim());
  const [searchOpen, setSearchOpen] = useState(Boolean(initial.query));
  const [treeOpen, setTreeOpen] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set(ancestorFolders(initial.path)));
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "info"; text: string }>();
  const [copiedBlock, setCopiedBlock] = useState<string>();
  const composing = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const firstRoute = useRef(true);

  const selectedDocument = documentsByPath.get(selectedPath);
  const searchResults = useMemo(() => {
    if (!deferredQuery) return [];
    try {
      return searchIndex.search(deferredQuery, { fuzzy: deferredQuery.length >= 4 ? 0.15 : false }).slice(0, 18) as unknown as SearchResult[];
    } catch {
      const normalized = deferredQuery.toLocaleLowerCase("zh-CN");
      return documents
        .filter((document) => `${document.title} ${document.summary} ${document.plainText}`.toLocaleLowerCase("zh-CN").includes(normalized))
        .slice(0, 18)
        .map(({ id, path, title, summary, category, kind }) => ({ id, path, title, summary, category, kind }));
    }
  }, [deferredQuery]);

  useEffect(() => {
    const handlePopState = () => {
      const next = initialUrlState();
      setSelectedPath(next.path);
      setQuery(next.query);
      setSearchOpen(Boolean(next.query));
      setExpanded((current) => new Set([...current, ...ancestorFolders(next.path)]));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      window.history.replaceState(null, "", documentUrl(selectedPath, query));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, selectedPath]);

  useEffect(() => {
    const title = selectedDocument?.title ?? "页面未找到";
    window.document.title = `${title} — Forge AI 交付手册`;
    contentRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [selectedDocument]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), 2800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const navigateToDocument = (path: string, options?: { replace?: boolean; preserveSearch?: boolean }) => {
    const nextQuery = options?.preserveSearch ? query : "";
    if (options?.replace) window.history.replaceState(null, "", documentUrl(path, nextQuery));
    else window.history.pushState(null, "", documentUrl(path, nextQuery));
    setSelectedPath(path);
    setQuery(nextQuery);
    setSearchOpen(false);
    setTreeOpen(false);
    setExpanded((current) => new Set([...current, ...ancestorFolders(path)]));
  };

  const notifyCopy = async (text: string, label: string, blockId?: string) => {
    try {
      await copyText(text);
      setCopiedBlock(blockId);
      setNotice({ tone: "success", text: `${label}已复制，可以直接粘贴给 AI` });
      window.setTimeout(() => setCopiedBlock((current) => current === blockId ? undefined : current), 1800);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "复制失败，请手动选择文本" });
    }
  };

  const shareDocument = async () => {
    if (!selectedDocument) return;
    try {
      const shareUrl = new URL(documentUrl(selectedDocument.path), window.location.origin).toString();
      await copyText(shareUrl);
      setNotice({ tone: "success", text: "当前文档链接已复制" });
    } catch {
      setNotice({ tone: "error", text: "链接复制失败，请从地址栏复制" });
    }
  };

  const markdownComponents: Components = useMemo(() => ({
    a: ({ href = "", children, ...props }) => {
      if (href.startsWith("#")) return <a href={href} {...props}>{children}</a>;
      const resolved = selectedDocument ? resolveMarkdownLink(selectedDocument.path, href) : undefined;
      if (resolved) {
        return <a href={documentUrl(resolved)} onClick={(event) => { event.preventDefault(); navigateToDocument(resolved); }}>{children}</a>;
      }
      if (/^https?:/i.test(href)) return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
      if (href.toLowerCase().includes(".md")) return <span className="repository-reference" title="该链接指向门户范围外的仓库文档">{children}<small>仓库参考</small></span>;
      return <a href={href} {...props}>{children}</a>;
    },
    pre: ({ children }) => {
      const code = textFromReactNode(children).replace(/\n$/, "");
      const blockId = `code-${code.slice(0, 48)}`;
      return (
        <div className="code-block-shell">
          <button type="button" onClick={() => void notifyCopy(code, "代码块", blockId)}>{copiedBlock === blockId ? "已复制" : "复制代码块"}</button>
          <pre>{children}</pre>
        </div>
      );
    },
    h2: ({ children }) => <h2 id={headingId(children)}>{children}</h2>,
    h3: ({ children }) => <h3 id={headingId(children)}>{children}</h3>,
    h4: ({ children }) => <h4 id={headingId(children)}>{children}</h4>
  }), [copiedBlock, selectedDocument]);

  const displayMarkdown = selectedDocument?.markdown.replace(/^#\s+.+?\r?\n+/, "") ?? "";
  const firstCopyBlock = selectedDocument?.copyBlocks[0];
  const activeStage = stages.find((stage) => selectedDocument?.category === stage.id)?.id;
  const templateCount = documents.filter((document) => document.kind === "template").length;
  const recipeCount = documents.filter((document) => document.kind === "recipe").length;

  return (
    <div className="app-shell">
      <header className="app-header">
        <button type="button" className="brand" onClick={() => defaultDocumentPath && navigateToDocument(defaultDocumentPath)} aria-label="返回三分钟快速开始">
          <span className="brand-seal" aria-hidden="true">F</span>
          <span><small>FORGE DELIVERY PLAYBOOK</small><strong>AI 交付手册</strong></span>
        </button>
        <div className={`global-search ${searchOpen ? "is-open" : ""}`}>
          <span className="search-glyph" aria-hidden="true">⌕</span>
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            aria-label="搜索交付模板"
            aria-expanded={searchOpen && Boolean(query)}
            aria-controls="search-results"
            placeholder="搜索：PRD、库表、权限、流程、发版……"
            onFocus={() => setSearchOpen(true)}
            onChange={(event) => setQuery(event.target.value)}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={(event) => { composing.current = false; setQuery(event.currentTarget.value); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setSearchOpen(false);
              if (event.key === "Enter" && !event.nativeEvent.isComposing && !composing.current && searchResults[0]) navigateToDocument(searchResults[0].path);
            }}
          />
          {query && <button type="button" className="search-clear" aria-label="清除搜索" onClick={() => { setQuery(""); setSearchOpen(false); searchInputRef.current?.focus(); }}>×</button>}
          {searchOpen && query && (
            <div className="search-results" id="search-results" role="region" aria-label="搜索结果">
              <div className="search-results-heading"><strong>{searchResults.length ? `找到 ${searchResults.length} 个相关入口` : "没有找到匹配内容"}</strong><span>回车打开第一项</span></div>
              {searchResults.length ? searchResults.map((result) => (
                <a key={result.path} href={documentUrl(result.path)} onClick={(event) => { event.preventDefault(); navigateToDocument(result.path); }}>
                  <span className={`search-kind kind-${result.kind}`}>{kindLabels[result.kind]}</span>
                  <strong>{result.title}</strong>
                  <small>{categoryLabel(result.category)} · {result.summary}</small>
                </a>
              )) : <div className="search-empty"><p>换一个更短的业务词试试，例如“字典”“审批”或“回退”。</p><button type="button" onClick={() => { setQuery(""); searchInputRef.current?.focus(); }}>清除搜索</button></div>}
            </div>
          )}
        </div>
        <nav className="header-shortcuts" aria-label="快捷入口">
          <a href={documentUrl("场景总导航.md")} onClick={(event) => { event.preventDefault(); navigateToDocument("场景总导航.md"); }}>按场景找</a>
          <a href={documentUrl("05-Forge-Admin底座复用/平台能力地图.md")} onClick={(event) => { event.preventDefault(); navigateToDocument("05-Forge-Admin底座复用/平台能力地图.md"); }}>能力地图</a>
        </nav>
      </header>

      <section className="delivery-rail" aria-label="AI 交付阶段">
        <div className="rail-heading"><span>交付轨道</span><small>只进入当前阶段，不让 AI 越级猜测</small></div>
        <div className="rail-stages">
          {stages.map((stage) => {
            const landing = stageLandingPath(stage.id);
            const count = documents.filter((document) => document.category === stage.id).length;
            return (
              <button key={stage.id} type="button" className={activeStage === stage.id ? "is-active" : ""} disabled={!landing} onClick={() => landing && navigateToDocument(landing)}>
                <span>{stage.short}</span><strong>{stage.label}</strong><small>{count} 份</small>
              </button>
            );
          })}
        </div>
      </section>

      <div className="mobile-tree-toggle-row">
        <button type="button" className="mobile-tree-toggle" aria-expanded={treeOpen} aria-controls="playbook-tree" onClick={() => setTreeOpen((current) => !current)}>
          <span aria-hidden="true">☷</span>{treeOpen ? "收起文档目录" : "打开文档目录"}
        </button>
        <span>{documents.length} 份文档 · {templateCount} 份可复制任务单</span>
      </div>

      <main className="workspace">
        <aside className={`tree-panel ${treeOpen ? "is-open" : ""}`} id="playbook-tree">
          <div className="tree-panel-heading">
            <div><small>MASTER TREE</small><h2>交付文档树</h2></div>
            <span>{documents.length}</span>
          </div>
          <nav aria-label="交付文档目录" className="tree-scroll">
            <ul className="tree-root">
              {documentTree.map((node) => (
                <TreeItem
                  key={node.key}
                  node={node}
                  selectedPath={selectedPath}
                  expanded={expanded}
                  onToggle={(path) => setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(path)) next.delete(path); else next.add(path);
                    return next;
                  })}
                  onSelect={navigateToDocument}
                />
              ))}
            </ul>
          </nav>
        </aside>

        <section className="document-panel" ref={contentRef} tabIndex={-1}>
          {selectedDocument ? (
            <>
              <header className="document-heading">
                <nav className="breadcrumbs" aria-label="当前位置">
                  <span>{categoryLabel(selectedDocument.category)}</span>
                  {selectedDocument.group !== selectedDocument.category && <span>{categoryLabel(selectedDocument.group)}</span>}
                  <span aria-current="page">{selectedDocument.title}</span>
                </nav>
                <div className="document-title-row">
                  <div>
                    <span className={`kind-label kind-${selectedDocument.kind}`}>{kindLabels[selectedDocument.kind]}</span>
                    <h1 tabIndex={-1}>{selectedDocument.title}</h1>
                    <p>{selectedDocument.summary}</p>
                  </div>
                  <dl className="document-facts">
                    <div><dt>阅读</dt><dd>{selectedDocument.readingMinutes} 分钟</dd></div>
                    <div><dt>可复制块</dt><dd>{selectedDocument.copyBlocks.length}</dd></div>
                  </dl>
                </div>
              </header>
              <article className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={markdownComponents}>{displayMarkdown}</ReactMarkdown>
              </article>
            </>
          ) : (
            <section className="route-error" aria-labelledby="not-found-title">
              <span>404</span><h1 id="not-found-title">这份文档不在当前手册中</h1><p>链接可能来自旧版本，或者指向仓库中的技术参考文件。</p>
              <button type="button" onClick={() => defaultDocumentPath && navigateToDocument(defaultDocumentPath, { replace: true })}>返回三分钟快速开始</button>
            </section>
          )}
        </section>

        <aside className="action-panel" aria-label="当前文档使用工具">
          {selectedDocument ? (
            <>
              <section className="ready-card">
                <span className="action-eyebrow">READY TO USE</span>
                <h2>拿来就用</h2>
                <p>{firstCopyBlock ? "已识别出可直接发送给 AI 的任务单。复制后先替换占位符。" : "这是说明或索引页，可复制全文，也可以沿页面链接继续选择任务单。"}</p>
                {firstCopyBlock && <button type="button" className="primary-action" onClick={() => void notifyCopy(firstCopyBlock.content, "任务单", firstCopyBlock.id)}>{copiedBlock === firstCopyBlock.id ? "任务单已复制" : "复制任务单给 AI"}</button>}
                <button type="button" className="secondary-action" onClick={() => void notifyCopy(selectedDocument.markdown, "完整 Markdown")}>复制完整 Markdown</button>
              </section>

              {selectedDocument.copyBlocks.length > 1 && (
                <section className="copy-block-list">
                  <h3>本页可复制内容</h3>
                  {selectedDocument.copyBlocks.map((block) => (
                    <button key={block.id} type="button" onClick={() => void notifyCopy(block.content, block.title, block.id)}>
                      <span>{copiedBlock === block.id ? "已复制" : "复制"}</span><strong>{block.title}</strong><small>{block.content.length} 字符</small>
                    </button>
                  ))}
                </section>
              )}

              <section className="action-list">
                <h3>更多操作</h3>
                <button type="button" onClick={() => downloadMarkdown(selectedDocument)}><span aria-hidden="true">↓</span><strong>下载源文件</strong><small>保留原始 Markdown</small></button>
                <button type="button" onClick={() => void shareDocument()}><span aria-hidden="true">↗</span><strong>复制分享链接</strong><small>同事可定位到本页</small></button>
                <button type="button" onClick={() => window.print()}><span aria-hidden="true">▤</span><strong>打印或转 PDF</strong><small>隐藏目录和操作栏</small></button>
              </section>

              <section className="use-checklist">
                <h3>粘贴给 AI 前</h3>
                <ol>
                  <li>把 <code>{"{{占位符}}"}</code> 换成真实信息。</li>
                  <li>未知内容明确写“未知”，不要让 AI 猜。</li>
                  <li>一次只要求一个可验收交付物。</li>
                  <li>权限、迁移和发布仍需人工授权。</li>
                </ol>
              </section>
              <p className="source-path" title={selectedDocument.path}>源：{selectedDocument.path}</p>
            </>
          ) : <p className="panel-empty">请从目录重新选择文档。</p>}
        </aside>
      </main>

      <footer className="app-footer">
        <span>Forge AI 交付手册</span>
        <span>{documents.length} 份文档 · {templateCount} 份任务单 · {recipeCount} 份配方</span>
        <span>只读发布 · 公司 VPN</span>
      </footer>

      <div className={`toast ${notice ? `is-visible tone-${notice.tone}` : ""}`} role="status" aria-live="polite">
        {notice?.text ?? ""}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
