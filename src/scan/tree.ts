import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ensureDir } from '../util/paths.js';

export interface TreeNode {
  name: string;
  type: 'dir' | 'file';
  path: string;
  size?: number;
  md5?: string;
  children?: TreeNode[];
}

interface MutableNode {
  name: string;
  type: 'dir' | 'file';
  path: string;
  size?: number;
  md5?: string;
  children?: Map<string, MutableNode>;
}

/**
 * Строит вложенное дерево из плоского списка путей Диска.
 *
 * Путь вида `disk:/foo/bar/file.txt` раскладывается на папки foo → bar → файл.
 */
export function buildTree(
  files: Array<{ path: string; size: number | null; md5: string | null }>,
): TreeNode {
  const root: MutableNode = { name: '', type: 'dir', path: 'disk:/', children: new Map() };

  for (const file of files) {
    const relative = file.path.replace(/^disk:\/*/, '');
    const segments = relative.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    let cursor = root;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] as string;
      const isLeaf = i === segments.length - 1;
      const childPath = `disk:/${segments.slice(0, i + 1).join('/')}`;
      cursor.children ??= new Map();
      let child = cursor.children.get(segment);
      if (!child) {
        child = isLeaf
          ? {
              name: segment,
              type: 'file',
              path: childPath,
              size: file.size ?? undefined,
              md5: file.md5 ?? undefined,
            }
          : { name: segment, type: 'dir', path: childPath, children: new Map() };
        cursor.children.set(segment, child);
      }
      cursor = child;
    }
  }

  return toTreeNode(root);
}

function toTreeNode(node: MutableNode): TreeNode {
  const result: TreeNode = { name: node.name, type: node.type, path: node.path };
  if (node.type === 'file') {
    if (node.size !== undefined) result.size = node.size;
    if (node.md5) result.md5 = node.md5;
  }
  if (node.children) {
    result.children = [...node.children.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(toTreeNode);
  }
  return result;
}

/** Записывает дерево в JSON-файл. */
export function writeTreeFile(file: string, tree: TreeNode): void {
  ensureDir(dirname(file));
  writeFileSync(file, `${JSON.stringify(tree, null, 2)}\n`, 'utf8');
}
