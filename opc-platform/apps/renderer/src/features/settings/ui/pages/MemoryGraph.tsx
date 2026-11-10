import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { entityTypeLabel, predicateLabel } from './ontologyLabels';

/**
 * 关系记忆图：以「用户」为圆心，实体按跳数排成两圈，连线是关系。
 *
 * 为什么不用力导向：这里的数据每次都从同一个主体出发（`ontology.context` 以用户为
 * 中心、最多两跳），力导向的随机性只会让同一份数据每次长得不一样。固定环布局让
 * 「直接关系 / 间接关系」在位置上一眼可辨，也不需要额外依赖。
 *
 * 视觉上刻意做成「仪表盘」而不是「社交网络图」：细线、同心轨道、单一强调色，
 * 节点的明暗只表达层级（自己 / 直接 / 间接），不按类型上彩虹色。
 * 悬停会临时把视线收到一个实体上，移开就恢复；点击则是把焦点固定下来。
 *
 * 图只负责看结构。谓词不画成飘在线上的气泡——那在圆心附近一定会堆成一坨；
 * 而是挂在相邻节点名字下面当副标题：一个邻居一行字，永远不会互相压。
 * 证据、置信度和「撤回」都在下方按选中实体过滤后的列表里。
 */

const CENTER_ID = 'ontology-user';
const WIDTH = 560;
const HEIGHT = 440;
const CX = WIDTH / 2;
const CY = 212;
const RING_1 = 130;
const RING_2 = 186;

interface EntityLike {
  id: string;
  entityType: string;
  canonicalName: string;
}

interface AssertionLike {
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string | null;
}

interface LayoutNode {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  r: number;
  degree: number;
}

interface LayoutEdge {
  key: string;
  from: LayoutNode;
  to: LayoutNode;
  predicates: string[];
}

function truncate(text: string, max = 12): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/** 稳定散列：同一条边永远向同一侧弯，刷新不会换形状。 */
function keySeed(key: string): number {
  let total = 0;
  for (let index = 0; index < key.length; index += 1) total += key.charCodeAt(index);
  return total % 2 === 0 ? 1 : -1;
}

function buildLayout(entities: EntityLike[], assertions: AssertionLike[]) {
  const meta = new Map<string, { name: string; type: string }>();
  for (const entity of entities) {
    meta.set(entity.id, { name: entity.canonicalName, type: entity.entityType });
  }
  const ensure = (id: string) => {
    if (!meta.has(id)) meta.set(id, { name: id, type: 'Entity' });
  };

  const edgeMap = new Map<string, { fromId: string; toId: string; predicates: Set<string> }>();
  for (const assertion of assertions) {
    ensure(assertion.subjectEntityId);
    if (!assertion.objectEntityId) continue;
    ensure(assertion.objectEntityId);
    const key = `${assertion.subjectEntityId}|${assertion.objectEntityId}`;
    const existing = edgeMap.get(key);
    if (existing) existing.predicates.add(assertion.predicate);
    else {
      edgeMap.set(key, {
        fromId: assertion.subjectEntityId,
        toId: assertion.objectEntityId,
        predicates: new Set([assertion.predicate]),
      });
    }
  }

  const neighbors = new Map<string, Set<string>>();
  const degree = new Map<string, number>();
  for (const id of meta.keys()) {
    neighbors.set(id, new Set());
    degree.set(id, 0);
  }
  for (const edge of edgeMap.values()) {
    neighbors.get(edge.fromId)!.add(edge.toId);
    neighbors.get(edge.toId)!.add(edge.fromId);
    degree.set(edge.fromId, (degree.get(edge.fromId) ?? 0) + 1);
    degree.set(edge.toId, (degree.get(edge.toId) ?? 0) + 1);
  }

  // 圆心优先取用户实体；没有就取连接最多的那个，至少图不会空着。
  // 没有任何关系的实体不进图：一个孤立圆点说明不了「关系记忆」。
  const referenced = new Set<string>();
  for (const assertion of assertions) {
    referenced.add(assertion.subjectEntityId);
    if (assertion.objectEntityId) referenced.add(assertion.objectEntityId);
  }
  const ids = referenced.size > 0
    ? [...meta.keys()].filter((id) => referenced.has(id))
    : [...meta.keys()];
  const centreId = meta.has(CENTER_ID) && ids.includes(CENTER_ID)
    ? CENTER_ID
    : [...ids].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0))[0];

  const distance = new Map<string, number>();
  if (centreId) {
    distance.set(centreId, 0);
    const queue = [centreId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of neighbors.get(current) ?? []) {
        if (distance.has(next)) continue;
        distance.set(next, (distance.get(current) ?? 0) + 1);
        queue.push(next);
      }
    }
  }

  const byName = (a: string, b: string) =>
    (meta.get(a)?.type ?? '').localeCompare(meta.get(b)?.type ?? '') ||
    (meta.get(a)?.name ?? '').localeCompare(meta.get(b)?.name ?? '');

  const ringOne = ids.filter((id) => distance.get(id) === 1).sort(byName);
  const ringTwo = ids.filter((id) => (distance.get(id) ?? 2) >= 2).sort(byName);

  const angle = new Map<string, number>();
  const ringOneIndex = new Map<string, number>();
  ringOne.forEach((id, index) => {
    ringOneIndex.set(id, index);
    angle.set(id, -Math.PI / 2 + (index * 2 * Math.PI) / ringOne.length);
  });

  // 第二圈尽量贴着自己的父节点放，读者能顺着一条边找到来源。
  const groups = new Map<string, string[]>();
  const loose: string[] = [];
  for (const id of ringTwo) {
    const parents = [...(neighbors.get(id) ?? [])]
      .filter((candidate) => ringOneIndex.has(candidate))
      .sort((a, b) => ringOneIndex.get(a)! - ringOneIndex.get(b)!);
    const parent = parents[0];
    if (!parent) {
      loose.push(id);
      continue;
    }
    const bucket = groups.get(parent);
    if (bucket) bucket.push(id);
    else groups.set(parent, [id]);
  }

  for (const [parent, children] of groups) {
    const base = angle.get(parent) ?? 0;
    const step = 0.4;
    children.sort(byName).forEach((id, index) => {
      angle.set(id, base + (index - (children.length - 1) / 2) * step);
    });
  }
  loose.forEach((id, index) => {
    angle.set(id, -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(1, loose.length));
  });

  const nodes: LayoutNode[] = [];
  const nodeById = new Map<string, LayoutNode>();
  for (const id of ids) {
    const isCentre = id === centreId;
    const theta = angle.get(id) ?? -Math.PI / 2;
    const ring = isCentre ? 0 : distance.get(id) === 1 ? RING_1 : RING_2;
    // 圈内节点要放得下图标，所以比纯点图更大一些；外圈略小，保留层级。
    const radius = isCentre
      ? 28
      : ring === RING_1
        ? 17 + Math.min(2, Math.max(0, (degree.get(id) ?? 1) - 1))
        : 14 + Math.min(1.5, Math.max(0, (degree.get(id) ?? 1) - 1));
    const node: LayoutNode = {
      id,
      name: meta.get(id)?.name ?? id,
      type: meta.get(id)?.type ?? 'Entity',
      x: CX + Math.cos(theta) * ring,
      y: CY + Math.sin(theta) * ring,
      r: radius,
      degree: degree.get(id) ?? 0,
    };
    nodes.push(node);
    nodeById.set(id, node);
  }

  const edges: LayoutEdge[] = [];
  for (const [key, edge] of edgeMap) {
    const from = nodeById.get(edge.fromId);
    const to = nodeById.get(edge.toId);
    if (!from || !to) continue;
    edges.push({ key, from, to, predicates: [...edge.predicates] });
  }

  return { nodes, edges, centreId, neighbors };
}

/** 二次曲线：轻微弧度让连线不像是用尺子画的。 */
function edgeGeometry(edge: LayoutEdge): string {
  const dx = edge.to.x - edge.from.x;
  const dy = edge.to.y - edge.from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const bend = Math.max(10, Math.min(26, length * 0.16)) * keySeed(edge.key);

  const x1 = edge.from.x + ux * (edge.from.r + 3);
  const y1 = edge.from.y + uy * (edge.from.r + 3);
  const x2 = edge.to.x - ux * (edge.to.r + 9);
  const y2 = edge.to.y - uy * (edge.to.r + 9);
  const cx = (x1 + x2) / 2 - uy * bend;
  const cy = (y1 + y2) / 2 + ux * bend;

  return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
}

/**
 * 节点统一是「圆片 + 定制线性图标」：形状只负责说明它是什么，
 * 不再用彩色多边形抢注意力。用户用 accent，其余图标统一中性色。
 */
type NodeKind = 'user' | 'worker' | 'router' | 'task' | 'entity';

const NODE_PRIMARY_KINDS: NodeKind[] = ['user', 'router', 'worker', 'task'];

const KIND_TYPE: Record<NodeKind, string> = {
  user: 'User',
  worker: 'Worker',
  router: 'Router',
  task: 'Task',
  entity: 'Entity',
};

function nodeKind(entityType: string): NodeKind {
  switch (entityType) {
    case 'User':
      return 'user';
    case 'Worker':
      return 'worker';
    case 'Router':
      return 'router';
    case 'Task':
      return 'task';
    default:
      return 'entity';
  }
}

/**
 * 24×24 的线性图标，用 `size` 缩放到节点内部。
 * 线宽按缩放反算，保证每个节点上的线都是同一粗细。
 */
function TypeIcon({
  kind,
  size,
  color,
  strokeWidth = 1.35,
}: {
  kind: NodeKind;
  size: number;
  color: string;
  strokeWidth?: number;
}) {
  const scale = size / 24;
  return (
    <g
      transform={`translate(${-size / 2} ${-size / 2}) scale(${scale})`}
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth / scale}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === 'user' ? (
        <>
          <circle cx="12" cy="8.1" r="3.1" />
          <path d="M5.6 19.2c.4-3.3 3-5.4 6.4-5.4s6 2.1 6.4 5.4" />
        </>
      ) : kind === 'worker' ? (
        <>
          <rect x="7.3" y="7.3" width="9.4" height="9.4" rx="2.4" />
          <path d="M12 3.3v3.6M12 17.1v3.6M3.3 12h3.6M17.1 12h3.6" />
        </>
      ) : kind === 'router' ? (
        <>
          <circle cx="12" cy="5.7" r="1.9" />
          <circle cx="6.5" cy="18.1" r="1.9" />
          <circle cx="17.5" cy="18.1" r="1.9" />
          <path d="M12 7.6v3.1M11.1 10.8 7.6 16.1M12.9 10.8l3.5 5.3" />
        </>
      ) : kind === 'task' ? (
        <>
          <rect x="4.9" y="4.9" width="14.2" height="14.2" rx="3.2" />
          <path d="m8.6 12.2 2.4 2.4 4.5-4.8" />
        </>
      ) : (
        <circle cx="12" cy="12" r="2.3" />
      )}
    </g>
  );
}

function iconColor(kind: NodeKind): string {
  return kind === 'user' ? 'var(--accent)' : 'var(--text-secondary)';
}

function LegendMark({ kind }: { kind: NodeKind }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="shrink-0">
      <circle
        cx="9"
        cy="9"
        r="8"
        fill="var(--graph-node-bottom)"
        stroke="var(--graph-node-stroke)"
        strokeWidth={1}
      />
      <g transform="translate(9 9)">
        <TypeIcon kind={kind} size={12} color={iconColor(kind)} strokeWidth={1.1} />
      </g>
    </svg>
  );
}

export function MemoryGraph({
  entities,
  assertions,
  selectedId,
  onSelect,
  ariaLabel,
}: {
  entities: EntityLike[];
  assertions: AssertionLike[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  ariaLabel: string;
}) {
  const { nodes, edges, centreId, neighbors } = useMemo(
    () => buildLayout(entities, assertions),
    [entities, assertions],
  );
  const { t } = useTranslation();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const rawId = useId();
  const idPrefix = rawId.replace(/[^a-zA-Z0-9_-]/g, '');
  const mutedArrow = `${idPrefix}-arrow-muted`;
  const activeArrow = `${idPrefix}-arrow-active`;
  const bgGlow = `${idPrefix}-bg-glow`;
  const centerFill = `${idPrefix}-center-fill`;
  const nodeFill = `${idPrefix}-node-fill`;
  const softShadow = `${idPrefix}-soft-shadow`;

  const focusedId = hoveredId ?? selectedId;
  const highlighted = useMemo(() => {
    if (!focusedId) return null;
    return new Set([focusedId, ...(neighbors.get(focusedId) ?? [])]);
  }, [focusedId, neighbors]);

  // 谓词挂在邻居节点名下当副标题：一条边最多一句话，永远不会叠在一起。
  // 悬停/选中谁，就只显示和谁直接相关的那几条。
  const edgeCaptions = useMemo(() => {
    const captions = new Map<string, string>();
    if (!focusedId) return captions;
    for (const edge of edges) {
      const otherId =
        edge.from.id === focusedId ? edge.to.id : edge.to.id === focusedId ? edge.from.id : null;
      if (!otherId) continue;
      const labels = edge.predicates.map((predicate) => predicateLabel(t, predicate));
      const current = captions.get(otherId);
      captions.set(otherId, current ? `${current} · ${labels.join(' · ')}` : labels.join(' · '));
    }
    return captions;
  }, [edges, focusedId, t]);

  if (nodes.length === 0) return null;

  // 图注固定解释这四种主要节点：形状本身就是这套图的记号系统，
  // 即使当前数据里暂时没有某种节点，图注也保持完整。
  const legendKinds = NODE_PRIMARY_KINDS;
  const hasOtherEntities = nodes.some((node) => nodeKind(node.type) === 'entity');
  const legendLabel = (kind: NodeKind) =>
    kind === 'entity'
      ? t('settings.memory.ontologyLegendOther')
      : entityTypeLabel(t, KIND_TYPE[kind]);

  return (
    <div className="mx-auto w-full max-w-[32rem]">
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="block w-full select-none"
      >
      <defs>
        <radialGradient id={bgGlow} cx="50%" cy="46%" r="52%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.05" />
          <stop offset="70%" stopColor="var(--accent)" stopOpacity="0.01" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={centerFill} cx="36%" cy="30%" r="78%">
          <stop offset="0%" stopColor="var(--graph-centre-top)" />
          <stop offset="100%" stopColor="var(--graph-centre-bottom)" />
        </radialGradient>
        <radialGradient id={nodeFill} cx="34%" cy="28%" r="84%">
          <stop offset="0%" stopColor="var(--graph-node-top)" />
          <stop offset="100%" stopColor="var(--graph-node-bottom)" />
        </radialGradient>
        <filter id={softShadow} x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="1" stdDeviation="1.6" floodColor="#000000" floodOpacity="0.10" />
        </filter>
        <marker
          id={mutedArrow}
          viewBox="0 0 6 6"
          refX="5.6"
          refY="3"
          markerWidth="6"
          markerHeight="6"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M0.5 0.7 L5.4 3 L0.5 5.3 Z" fill="var(--text-quaternary)" fillOpacity="0.7" />
        </marker>
        <marker
          id={activeArrow}
          viewBox="0 0 6 6"
          refX="5.6"
          refY="3"
          markerWidth="6"
          markerHeight="6"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M0.5 0.7 L5.4 3 L0.5 5.3 Z" fill="var(--accent)" />
        </marker>
      </defs>

      {/* 背景：一圈很淡的光，把视线收在中心。 */}
      <circle cx={CX} cy={CY} r={RING_2 + 34} fill={`url(#${bgGlow})`} />

      {/* 轨道：两圈虚线，提示「直接 / 间接」的层级。 */}
      {[RING_1, RING_2].map((radius) => (
        <circle
          key={radius}
          cx={CX}
          cy={CY}
          r={radius}
          fill="none"
          stroke="var(--border)"
          strokeOpacity={0.9}
          strokeDasharray="1 6"
          strokeWidth={1}
        />
      ))}

      {edges.map((edge) => {
        const active = focusedId !== null && (edge.from.id === focusedId || edge.to.id === focusedId);
        const dimmed = focusedId !== null && !active;
        const path = edgeGeometry(edge);
        return (
          <g
            key={edge.key}
            style={{ opacity: dimmed ? 0.22 : 1, transition: 'opacity 180ms ease' }}
          >
            {active ? (
              <path
                d={path}
                fill="none"
                stroke="var(--accent)"
                strokeOpacity={0.12}
                strokeWidth={5}
                strokeLinecap="round"
              />
            ) : null}
            <path
              d={path}
              fill="none"
              stroke={active ? 'var(--accent)' : 'var(--border-strong)'}
              strokeWidth={active ? 1.4 : 1}
              strokeOpacity={active ? 0.95 : 0.85}
              strokeLinecap="round"
              markerEnd={`url(#${active ? activeArrow : mutedArrow})`}
            />
          </g>
        );
      })}

      {nodes.map((node) => {
        const selected = node.id === selectedId;
        const centre = node.id === centreId;
        const kind = nodeKind(node.type);
        const dimmed = highlighted !== null && !highlighted.has(node.id);
        const typeLabel = entityTypeLabel(t, node.type);
        const fill = centre ? `url(#${centerFill})` : `url(#${nodeFill})`;
        const stroke = selected || centre ? 'var(--accent)' : 'var(--graph-node-stroke)';
        const strokeWidth = selected ? 1.8 : centre ? 1.3 : 1;

        return (
          <g
            key={node.id}
            role="button"
            tabIndex={0}
            aria-label={`${node.name} · ${typeLabel}`}
            aria-pressed={selected}
            className="cursor-pointer"
            style={{ opacity: dimmed ? 0.3 : 1, transition: 'opacity 180ms ease' }}
            onClick={() => onSelect(selected ? null : node.id)}
            onMouseEnter={() => setHoveredId(node.id)}
            onMouseLeave={() => setHoveredId((current) => (current === node.id ? null : current))}
            onFocus={() => setHoveredId(node.id)}
            onBlur={() => setHoveredId((current) => (current === node.id ? null : current))}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onSelect(selected ? null : node.id);
            }}
          >
            <title>{`${node.name} · ${typeLabel} · ${t('settings.memory.ontologyRelationsCount', { count: node.degree })}`}</title>

            {/* 透明命中区：形状再小，点击范围也够大。 */}
            <circle cx={node.x} cy={node.y} r={node.r * 1.4} fill="transparent" />

            {selected || centre ? (
              <circle
                cx={node.x}
                cy={node.y}
                r={node.r * 1.2 + 8}
                fill="var(--accent)"
                fillOpacity={selected ? 0.12 : 0.06}
              />
            ) : null}

            {selected && !centre ? (
              <circle
                cx={node.x}
                cy={node.y}
                r={node.r * 1.2 + 5}
                fill="none"
                stroke="var(--accent)"
                strokeOpacity={0.4}
                strokeWidth={1}
              />
            ) : null}

            {/* 统一圆片：类型只由里面的图标表达，不靠颜色抢注意力。 */}
            <circle
              cx={node.x}
              cy={node.y}
              r={node.r}
              fill={fill}
              stroke={stroke}
              strokeWidth={strokeWidth}
              filter={`url(#${softShadow})`}
            />

            <g transform={`translate(${node.x} ${node.y})`}>
              <TypeIcon
                kind={kind}
                size={node.r * (centre ? 1.26 : 1.2)}
                color={iconColor(kind)}
                strokeWidth={centre ? 1.5 : 1.45}
              />
            </g>

            <text
              x={node.x}
              y={node.y + node.r + 13}
              textAnchor="middle"
              stroke="var(--surface)"
              strokeWidth={3}
              paintOrder="stroke"
              strokeLinejoin="round"
              className={
                selected || centre ? 'fill-[var(--text-primary)]' : 'fill-[var(--text-secondary)]'
              }
              style={{ fontSize: centre ? 11.5 : 10.5, fontWeight: selected || centre ? 600 : 500 }}
            >
              {truncate(node.name, 12)}
            </text>

            {edgeCaptions.get(node.id) ? (
              <text
                x={node.x}
                y={node.y + node.r + 25}
                textAnchor="middle"
                stroke="var(--surface)"
                strokeWidth={3}
                paintOrder="stroke"
                strokeLinejoin="round"
                className="fill-[var(--accent-text)]"
                style={{ fontSize: 9.5, fontWeight: 500 }}
              >
                {truncate(edgeCaptions.get(node.id)!, 12)}
              </text>
            ) : null}
          </g>
        );
      })}
      </svg>

      <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 px-4 pb-1.5 text-2xs text-ink-quaternary">
        {legendKinds.map((kind) => (
          <li key={kind} className="inline-flex items-center gap-1.5">
            <LegendMark kind={kind} />
            <span>{legendLabel(kind)}</span>
          </li>
        ))}
        {hasOtherEntities ? (
          <li className="inline-flex items-center gap-1.5">
            <LegendMark kind="entity" />
            <span>{legendLabel('entity')}</span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
