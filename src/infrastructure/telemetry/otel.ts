import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? 'api-gateway',
      'service.version': process.env.OTEL_SERVICE_VERSION ?? '1.0.0',
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 30_000,
    }),
    instrumentations: [
      new HttpInstrumentation(),
      new UndiciInstrumentation(),
    ],
  });

  sdk.start();

  if (process.env.NODE_ENV !== 'test') {
    const shutdown = async (): Promise<void> => {
      try {
        await sdk.shutdown();
      } finally {
        process.exit(0);
      }
    };
    process.on('SIGTERM', () => {
      void shutdown();
    });
    process.on('SIGINT', () => {
      void shutdown();
    });
  }
}
