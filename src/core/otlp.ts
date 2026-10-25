/** OTLP/HTTP JSON builders (spec §5). Only what Argus reads. */

export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue | undefined>;

interface KV {
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
}

export function attrs(a: Attrs | undefined): KV[] {
  const out: KV[] = [];
  if (!a) return out;
  for (const [key, v] of Object.entries(a)) {
    if (v === undefined) continue;
    if (typeof v === 'boolean') out.push({ key, value: { boolValue: v } });
    else if (typeof v === 'number') out.push({ key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } });
    else out.push({ key, value: { stringValue: String(v) } });
  }
  return out;
}

export const nanos = (ms: number): string => `${Math.round(ms * 1e6)}`;

export interface LogRecord {
  timeMs: number;
  severity: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  body: string;
  attributes?: Attrs;
  traceId?: string;
  spanId?: string;
}

const SEVERITY: Record<LogRecord['severity'], number> = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 };

export function logsRequest(resource: Attrs, records: LogRecord[]): string {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: attrs(resource) },
        scopeLogs: [
          {
            scope: { name: 'argus' },
            logRecords: records.map((r) => ({
              timeUnixNano: nanos(r.timeMs),
              severityNumber: SEVERITY[r.severity],
              severityText: r.severity.toUpperCase(),
              body: { stringValue: r.body },
              attributes: attrs(r.attributes),
              ...(r.traceId ? { traceId: r.traceId } : {}),
              ...(r.spanId ? { spanId: r.spanId } : {}),
            })),
          },
        ],
      },
    ],
  });
}

export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** 1 internal, 2 server, 3 client. */
  kind: 1 | 2 | 3;
  startMs: number;
  endMs: number;
  error?: string;
  attributes?: Attrs;
}

export function tracesRequest(resource: Attrs, spans: SpanData[]): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: attrs(resource) },
        scopeSpans: [
          {
            scope: { name: 'argus' },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.kind,
              startTimeUnixNano: nanos(s.startMs),
              endTimeUnixNano: nanos(s.endMs),
              attributes: attrs(s.attributes),
              status: s.error ? { code: 2, message: s.error } : { code: 1 },
            })),
          },
        ],
      },
    ],
  });
}

export type MetricPoint =
  | { kind: 'sum'; name: string; unit?: string; attributes?: Attrs; value: number; startMs: number; endMs: number }
  | { kind: 'gauge'; name: string; unit?: string; attributes?: Attrs; value: number; endMs: number }
  | {
      kind: 'histogram';
      name: string;
      unit?: string;
      attributes?: Attrs;
      count: number;
      sum: number;
      min: number;
      max: number;
      bounds: number[];
      buckets: number[];
      startMs: number;
      endMs: number;
    };

export function metricsRequest(resource: Attrs, points: MetricPoint[]): string {
  const metrics = points.map((p) => {
    const base = { name: p.name, ...(p.unit ? { unit: p.unit } : {}) };
    const attributes = attrs(p.attributes);
    if (p.kind === 'sum') {
      return {
        ...base,
        sum: {
          aggregationTemporality: 1, // delta
          isMonotonic: true,
          dataPoints: [{ attributes, startTimeUnixNano: nanos(p.startMs), timeUnixNano: nanos(p.endMs), asDouble: p.value }],
        },
      };
    }
    if (p.kind === 'gauge') {
      return { ...base, gauge: { dataPoints: [{ attributes, timeUnixNano: nanos(p.endMs), asDouble: p.value }] } };
    }
    return {
      ...base,
      histogram: {
        aggregationTemporality: 1,
        dataPoints: [
          {
            attributes,
            startTimeUnixNano: nanos(p.startMs),
            timeUnixNano: nanos(p.endMs),
            count: String(p.count),
            sum: p.sum,
            min: p.min,
            max: p.max,
            explicitBounds: p.bounds,
            bucketCounts: p.buckets.map(String),
          },
        ],
      },
    };
  });
  return JSON.stringify({ resourceMetrics: [{ resource: { attributes: attrs(resource) }, scopeMetrics: [{ scope: { name: 'argus' }, metrics }] }] });
}
