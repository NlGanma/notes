import type { Editor } from '@tiptap/core';
import type { InkLayerHandle } from './ink/InkLayer';

/** Live editor instances by note id (for top-bar actions, export, AI). */
export const editors = new Map<string, Editor>();
export const inkLayers = new Map<string, InkLayerHandle>();

export function lineHeightFor(editor: Editor): number {
  return parseFloat(getComputedStyle(editor.view.dom).getPropertyValue('--line')) || 32;
}
