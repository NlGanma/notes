import type { JSONContent } from '@tiptap/core';
import type { Paper } from '../../state/settings';
import { isSafeColor, sanitizeDoc } from './sanitize';

export interface NoteMeta {
  id: string;
  title: string;
  /** Folder path relative to the vault root ('' = root), e.g. "Spring/Calculus". */
  folder: string;
  tags: string[];
  created: number;
  updated: number;
  pinned?: boolean;
  /** Set when the note is in the trash (timestamp). */
  trashed?: number;
  paper?: Paper;
  /** Accent colour for the notebook card. */
  color?: string;
  /** Present when the note is a homework assignment. */
  homework?: HomeworkMeta;
  /** Written by the AI (e.g. saved flashcards): never cited back as class material. */
  generated?: boolean;
}

export interface HomeworkMeta {
  /** Notes linked as the sources for this homework. */
  sources: string[];
  /** Whole folders linked as sources (every note inside counts). */
  folders: string[];
  due?: number;
  done?: boolean;
}

export interface NoteDoc {
  version: 1;
  meta: NoteMeta;
  content: JSONContent;
}

export interface FolderMeta {
  color?: string;
  icon?: string;
  /** 'class' turns a top-level folder into a class: its notes, homework and Q&A are grouped together. */
  kind?: 'class';
  /** Course code, e.g. "MATH 1A". */
  code?: string;
  instructor?: string;
  /** e.g. "Fall 2026". */
  term?: string;
  archived?: boolean;
  created?: number;
}

export interface VaultSnapshot {
  notes: NoteDoc[];
  folders: string[];
  folderMeta: Record<string, FolderMeta>;
}

export interface VaultBackend {
  kind: 'browser' | 'fs';
  /** Human readable location of the vault. */
  label: string;
  load(): Promise<VaultSnapshot>;
  saveNote(doc: NoteDoc): Promise<void>;
  /** Best-effort synchronous save used while the window closes. */
  saveNoteSync?(doc: NoteDoc): void;
  deleteNote(id: string): Promise<void>;
  createFolder(path: string): Promise<void>;
  renameFolder(from: string, to: string): Promise<void>;
  deleteFolder(path: string): Promise<void>;
  saveFolderMeta(meta: Record<string, FolderMeta>): Promise<void>;
  readKV(key: string): Promise<string | null>;
  writeKV(key: string, value: string): Promise<void>;
  /** Best-effort synchronous write used while the window closes. */
  writeKVSync?(key: string, value: string): void;
  reveal?(id: string): void;
}

export const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

export function parseNoteFile(text: string): NoteDoc | null {
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || !raw.meta?.id) return null;
    const meta = raw.meta as NoteMeta;
    return {
      version: 1,
      meta: {
        id: String(meta.id),
        title: String(meta.title ?? 'Untitled'),
        folder: String(meta.folder ?? ''),
        tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
        created: Number(meta.created) || Date.now(),
        updated: Number(meta.updated) || Date.now(),
        pinned: !!meta.pinned,
        trashed: meta.trashed ? Number(meta.trashed) : undefined,
        paper: (['blank', 'ruled', 'legal', 'grid', 'dots'] as const).includes(meta.paper as never) ? meta.paper : undefined,
        color: isSafeColor(meta.color) ? meta.color : undefined,
        homework:
          meta.homework && typeof meta.homework === 'object'
            ? {
                sources: Array.isArray(meta.homework.sources) ? meta.homework.sources.map(String) : [],
                folders: Array.isArray(meta.homework.folders) ? meta.homework.folders.map(String) : [],
                due: meta.homework.due ? Number(meta.homework.due) : undefined,
                done: !!meta.homework.done,
              }
            : undefined,
        generated: meta.generated ? true : undefined,
      },
      // Files can come from anywhere: coerce everything that ends up in markup.
      content: raw.content?.type === 'doc' ? sanitizeDoc(raw.content) : EMPTY_DOC,
    };
  } catch {
    return null;
  }
}

export function serializeNote(doc: NoteDoc): string {
  return JSON.stringify({ format: 'nib-note', version: 1, meta: doc.meta, content: doc.content });
}
