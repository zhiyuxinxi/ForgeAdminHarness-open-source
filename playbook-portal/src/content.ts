import type { CopyBlock, PlaybookDocument, StageDefinition, TreeNode } from "./types";

const sourceModules = import.meta.glob("../../docs/ai-delivery-playbook/**/*.md", {
  eager: true,
  import: "default",
  query: "?raw"
}) as Record<string, string>;

export const stages: StageDefinition[] = [
  { id: "00-开始使用", short: "00", label: "开始使用", description: "选任务、给上下文、控制 Token" },
  { id: "01-需求与产品", short: "01", label: "需求与产品", description: "把想法变成可验收定义" },
  { id: "02-系统与实现", short: "02", label: "系统与实现", description: "统一数据、权限、流程与接口" },
  { id: "03-质量与发布", short: "03", label: "质量与发布", description: "以证据验收、发布和回退" },
  { id: "04-协作与治理", short: "04", label: "协作治理", description: "会议、交接、纠偏与压缩" },
  { id: "05-Forge-Admin底座复用", short: "05", label: "底座复用", description: "优先复用 Forge Admin 能力" },
  { id: "06-黄金交付配方", short: "06", label: "黄金配方", description: "按端到端链路组合任务单" }
];

function normaliseSourcePath(sourcePath: string): string {
  const normalised = sourcePath.replaceAll("\\", "/");
  const marker = "/docs/ai-delivery-playbook/";
  const markerIndex = normalised.lastIndexOf(marker);
  if (markerIndex >= 0) return normalised.slice(markerIndex + marker.length);
  return normalised.replace(/^.*ai-delivery-playbook\//, "");
}

export function stripOrderPrefix(value: string): string {
  return value.replace(/^\d{2}-/, "").replace(/\.md$/i, "");
}

export function extractHeadings(markdown: string): string[] {
  return [...markdown.matchAll(/^#{1,4}\s+(.+?)\s*$/gm)].map((match) => match[1].replace(/[`*_]/g, "").trim());
}

function extractTitle(markdown: string, path: string): string {
  const heading = markdown.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
  return heading || stripOrderPrefix(path.split("/").at(-1) ?? path);
}

function extractSummary(markdown: string): string {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, "");
  const paragraphs = withoutCode.split(/\r?\n\s*\r?\n/);
  for (const paragraph of paragraphs) {
    const text = paragraph
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^(#|[-*+]\s|\d+\.\s|\||>|```)/.test(line))
      .join(" ")
      .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
      .replace(/[`*_]/g, "")
      .trim();
    if (text.length >= 16) return text.slice(0, 132);
  }
  return "本页提供当前场景的输入、执行约束、输出合同与人工验收要求。";
}

export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n/g, " ")
    .replace(/```/g, " ")
    .replace(/!\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+>]\s+/gm, "")
    .replace(/[|`*_~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value: string): string {
  return value
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "") || "copy-block";
}

export function extractCopyBlocks(markdown: string): CopyBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: CopyBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const heading = lines[index].match(/^(#{2,4})\s+(.+?)\s*$/);
    if (!heading) {
      index += 1;
      continue;
    }

    const level = heading[1].length;
    const title = heading[2].replace(/[`*_]/g, "").trim();
    let end = index + 1;
    while (end < lines.length) {
      const nextHeading = lines[end].match(/^(#{1,4})\s+/);
      if (nextHeading && nextHeading[1].length <= level) break;
      end += 1;
    }

    if (/复制|提示词|给.*AI|任务单/.test(title)) {
      const section = lines.slice(index + 1, end).join("\n");
      const codeBlocks = [...section.matchAll(/```(?:text|markdown|md)?\s*\n([\s\S]*?)```/g)];
      codeBlocks.forEach((match, blockIndex) => {
        const content = match[1].trim();
        if (!content) return;
        blocks.push({
          id: `${slugify(title)}-${blockIndex + 1}`,
          title: codeBlocks.length > 1 ? `${title} ${blockIndex + 1}` : title,
          content
        });
      });
    }

    index = end;
  }

  return blocks;
}

function inferKind(path: string, copyBlocks: CopyBlock[]): PlaybookDocument["kind"] {
  const fileName = path.split("/").at(-1) ?? path;
  if (path.startsWith("_meta/")) return "meta";
  if (path.startsWith("06-黄金交付配方/")) return "recipe";
  if (fileName.includes("证据")) return "evidence";
  if (fileName === "README.md" || !path.includes("/")) return "index";
  if (copyBlocks.length) return "template";
  return "guide";
}

function readingMinutes(plainText: string): number {
  const chineseCharacters = (plainText.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latinWords = (plainText.match(/[A-Za-z0-9_-]+/g) ?? []).length;
  return Math.max(1, Math.ceil((chineseCharacters + latinWords * 2) / 420));
}

function createDocuments(): PlaybookDocument[] {
  return Object.entries(sourceModules)
    .map(([sourcePath, markdown]) => ({ path: normaliseSourcePath(sourcePath), markdown }))
    .sort((a, b) => a.path.localeCompare(b.path, "zh-CN", { numeric: true }))
    .map(({ path, markdown }, index) => {
      const copyBlocks = extractCopyBlocks(markdown);
      const plainText = markdownToPlainText(markdown);
      const parts = path.split("/");
      return {
        id: index + 1,
        path,
        title: extractTitle(markdown, path),
        summary: extractSummary(markdown),
        markdown,
        plainText,
        headings: extractHeadings(markdown),
        copyBlocks,
        category: parts.length > 1 ? parts[0] : "总览",
        group: parts.length > 2 ? parts[1] : parts.length > 1 ? parts[0] : "总览",
        kind: inferKind(path, copyBlocks),
        readingMinutes: readingMinutes(plainText)
      } satisfies PlaybookDocument;
    });
}

export const documents = createDocuments();
export const documentsByPath = new Map(documents.map((document) => [document.path, document]));

function folderLabel(segment: string): string {
  if (segment === "_meta") return "维护与证据";
  return stripOrderPrefix(segment);
}

function sortTree(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .map((node) => node.type === "folder" ? { ...node, children: sortTree(node.children) } : node)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      if (a.key.startsWith("_meta")) return 1;
      if (b.key.startsWith("_meta")) return -1;
      if (a.type === "document" && a.document.path.endsWith("/README.md")) return -1;
      if (b.type === "document" && b.document.path.endsWith("/README.md")) return 1;
      return a.key.localeCompare(b.key, "zh-CN", { numeric: true });
    });
}

export function buildDocumentTree(sourceDocuments: PlaybookDocument[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const document of sourceDocuments) {
    const segments = document.path.split("/");
    let children = root;
    let folderPath = "";
    for (const segment of segments.slice(0, -1)) {
      folderPath = folderPath ? `${folderPath}/${segment}` : segment;
      let folder = children.find((node): node is Extract<TreeNode, { type: "folder" }> => node.type === "folder" && node.key === folderPath);
      if (!folder) {
        folder = { type: "folder", key: folderPath, label: folderLabel(segment), children: [] };
        children.push(folder);
      }
      children = folder.children;
    }
    children.push({ type: "document", key: document.path, label: document.title, document });
  }

  return sortTree(root);
}

export const documentTree = buildDocumentTree(documents);

function normaliseRelativePath(path: string): string | undefined {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

export function resolveMarkdownLink(currentPath: string, href: string, knownPaths = documentsByPath): string | undefined {
  if (!href || href.startsWith("#") || href.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined;
  const pathOnly = decodeURIComponent(href.split(/[?#]/, 1)[0]);
  if (!pathOnly.toLowerCase().endsWith(".md")) return undefined;
  const currentDirectory = currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/")) : "";
  const resolved = normaliseRelativePath(currentDirectory ? `${currentDirectory}/${pathOnly}` : pathOnly);
  return resolved && knownPaths.has(resolved) ? resolved : undefined;
}

export function categoryLabel(category: string): string {
  if (category === "总览") return "总览";
  if (category === "_meta") return "维护与证据";
  return stripOrderPrefix(category);
}

export function stageLandingPath(stageId: string): string | undefined {
  const exactReadme = `${stageId}/README.md`;
  if (documentsByPath.has(exactReadme)) return exactReadme;
  return documents.find((document) => document.path.startsWith(`${stageId}/`))?.path;
}

export const defaultDocumentPath = documentsByPath.has("00-开始使用/01-三分钟快速开始.md")
  ? "00-开始使用/01-三分钟快速开始.md"
  : documents[0]?.path;
