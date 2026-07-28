// SPDX-License-Identifier: MIT
import { SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';

/**
 * OpenTelemetry hooks.
 *
 * Toran depends only on `@opentelemetry/api`, never on an SDK. With no SDK
 * registered the API is a no-op, so instrumentation costs nothing by default.
 * Operators who want traces register a provider in their own bootstrap (see
 * `docs/OBSERVABILITY.md`) and every span below starts flowing without any
 * change to Toran.
 */
export function getTracer(name = 'toran'): Tracer {
  return trace.getTracer(name);
}

export interface SpanAttributes {
  readonly [key: string]: string | number | boolean | undefined;
}

/** Runs `fn` inside a span, recording failures without swallowing them. */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, async (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        // Only the error name: messages can carry request detail.
        message: error instanceof Error ? error.name : 'error',
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

export interface MetricSample {
  readonly name: string;
  readonly value: number;
  readonly attributes: SpanAttributes;
}

/**
 * Minimal counter/histogram sink.
 *
 * Deliberately not an OTel Meter: the MVP only needs request and job counts
 * that operators can scrape from logs. Swapping this for a real meter is a
 * single-file change.
 */
export class MetricsRecorder {
  private readonly samples: MetricSample[] = [];

  record(name: string, value: number, attributes: SpanAttributes = {}): void {
    this.samples.push({ name, value, attributes });
    if (this.samples.length > 1000) this.samples.shift();
  }

  drain(): MetricSample[] {
    return this.samples.splice(0, this.samples.length);
  }

  snapshot(): readonly MetricSample[] {
    return [...this.samples];
  }
}

export const metrics = new MetricsRecorder();
