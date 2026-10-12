import { describe, expect, it } from "vitest";
import { buildDocumentTree, documents, documentsByPath, extractCopyBlocks, resolveMarkdownLink, stripOrderPrefix } from "./content";

describe("playbook content index", () => {
  it("indexes every non-empty Markdown document with a stable path", () => {
    expect(documents.length).toBeGreaterThanOrEqual(80);
    expect(new Set(documents.map((document) => document.path)).size).toBe(documents.length);
    for (const document of documents) {
      expect(document.title.length).toBeGreaterThan(1);
      expect(document.markdown.trim().length).toBeGreaterThan(20);
    }
  });

  it("extracts copy-ready AI prompts", () => {
    const blocks = extractCopyBlocks(`# 示例\n\n## 可直接复制给 AI\n\n\`\`\`text\n请生成一份 PRD。\n\`\`\``);
    expect(blocks).toEqual([{ id: "可直接复制给-ai-1", title: "可直接复制给 AI", content: "请生成一份 PRD。" }]);
    expect(documents.some((document) => document.copyBlocks.length > 0)).toBe(true);
  });

  it("resolves internal Markdown links without escaping the playbook", () => {
    expect(resolveMarkdownLink("00-开始使用/01-三分钟快速开始.md", "../场景总导航.md")).toBe("场景总导航.md");
    expect(resolveMarkdownLink("README.md", "../security.md")).toBeUndefined();
    expect(resolveMarkdownLink("README.md", "https://example.com/a.md")).toBeUndefined();
  });

  it("builds a meaningful multi-level tree", () => {
    const tree = buildDocumentTree(documents);
    const needsAndProduct = tree.find((node) => node.type === "folder" && node.key === "01-需求与产品");
    expect(needsAndProduct?.type).toBe("folder");
    if (needsAndProduct?.type === "folder") expect(needsAndProduct.children.length).toBeGreaterThan(2);
    expect(documentsByPath.has("05-Forge-Admin底座复用/平台能力地图.md")).toBe(true);
  });

  it("removes only the ordering prefix from display labels", () => {
    expect(stripOrderPrefix("05-Forge-Admin底座复用")).toBe("Forge-Admin底座复用");
    expect(stripOrderPrefix("01-编写可验收PRD.md")).toBe("编写可验收PRD");
  });
});
