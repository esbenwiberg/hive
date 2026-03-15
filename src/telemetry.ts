/**
 * Application Insights telemetry initialization.
 *
 * Must be imported as the FIRST module in src/index.ts so the SDK can
 * auto-instrument Express, HTTP, and other modules before they're loaded.
 *
 * Gated on APPLICATIONINSIGHTS_CONNECTION_STRING — graceful no-op when absent
 * (dev/local environments work identically without it).
 */

const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

if (connectionString) {
  try {
    const appInsights = await import("applicationinsights");
    appInsights.default
      .setup(connectionString)
      .setAutoCollectRequests(true)
      .setAutoCollectPerformance(true, true)
      .setAutoCollectExceptions(true)
      .setAutoCollectDependencies(true)
      .setAutoDependencyCorrelation(true)
      .start();

    // eslint-disable-next-line no-console
    console.log("[telemetry] Application Insights initialized");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[telemetry] Failed to initialize Application Insights:", err);
  }
}

export {};
