export interface CopyBlock {
  id: string;
  title: string;
  content: string;
}

export interface PlaybookDocument {
  id: number;
  path: string;
  title: string;
  summary: string;
  markdown: string;
  plainText: string;
  headings: string[];
  copyBlocks: CopyBlock[];
  category: string;
  group: string;
  kind: "guide" | "template" | "recipe" | "evidence" | "index" | "meta";
  readingMinutes: number;
}

export interface FolderTreeNode {
  type: "folder";
  key: string;
  label: string;
  children: TreeNode[];
}

export interface DocumentTreeNode {
  type: "document";
  key: string;
  label: string;
  document: PlaybookDocument;
}

export type TreeNode = FolderTreeNode | DocumentTreeNode;

export interface StageDefinition {
  id: string;
  short: string;
  label: string;
  description: string;
}

export interface SearchResult {
  id: number;
  path: string;
  title: string;
  summary: string;
  category: string;
  kind: PlaybookDocument["kind"];
  score?: number;
}
