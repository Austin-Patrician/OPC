import type * as THREE from 'three';

/**
 * Writes the world position for a label into `out` and may update the element.
 * Return false to hide the label for this frame.
 */
export type LabelAnchor = (out: THREE.Vector3, el: HTMLElement) => boolean;

/**
 * Connects 3D anchor points (registered inside the canvas) with plain DOM labels
 * rendered in the page's own React tree. The canvas projects every anchor each
 * frame and positions the matching element, so labels stay crisp and layered
 * with the HUD without spawning extra React roots.
 */
export class LabelBridge {
  anchors = new Map<string, LabelAnchor>();
  elements = new Map<string, HTMLElement>();

  bind = (id: string) => (el: HTMLElement | null) => {
    if (el) this.elements.set(id, el);
    else this.elements.delete(id);
  };
}
