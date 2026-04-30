const { performance } = require("node:perf_hooks");
const { SqlRegistry, SqlRegistryAdapter } = require("../dist");

const WARMUP_ITERATIONS = 20_000;
const DEFAULT_ITERATIONS = 200_000;

function createRegistry(options = {}) {
  const registry = new SqlRegistry({ strict: false, dialect: "pg", ...options });

  registry.queries["users.findById"] = {
    meta: {
      params: [
        { name: "id", type: "integer", description: "User id" }
      ]
    },
    sql: {
      default: "SELECT id, name, role FROM users WHERE id = :id"
    }
  };

  registry.queries["users.search"] = {
    meta: {
      params: [
        { name: "tenantId", type: "integer", description: "Tenant id" },
        { name: "name", type: "string", description: "Name filter" },
        { name: "active", type: "boolean", description: "Active filter" },
        { name: "limit", type: "integer", description: "Maximum rows" },
        { name: "offset", type: "integer", description: "Rows to skip" }
      ],
      orderable: {
        createdAt: "users.created_at",
        name: "users.name"
      },
      builder: [
        "if (params.name) {",
        "  append('where', 'AND users.name LIKE :name', { name: params.name });",
        "}",
        "if (params.active !== undefined) {",
        "  append('where', 'AND users.active = :active', { active: params.active });",
        "}",
        "if (context.sort) {",
        "  orderBy('order', context.sort, false);",
        "}",
        "limit('page', params.limit);",
        "offset('page', params.offset);"
      ].join("\n")
    },
    sql: {
      default: [
        "SELECT users.id, users.name, users.active",
        "FROM users",
        "WHERE users.tenant_id = :tenantId",
        "/*#where*/",
        "/*#order*/",
        "/*#page*/"
      ].join("\n")
    }
  };

  return registry;
}

function formatNumber(value) {
  return Math.round(value).toLocaleString("en-US");
}

function benchmark(name, iterations, fn) {
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    fn(i);
  }

  const startedAt = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn(i);
  }
  const elapsedMs = performance.now() - startedAt;
  const opsPerSecond = iterations / (elapsedMs / 1000);
  const microsecondsPerOp = (elapsedMs * 1000) / iterations;

  return {
    name,
    iterations,
    elapsedMs,
    opsPerSecond,
    microsecondsPerOp
  };
}

function printResults(results) {
  const nameWidth = Math.max(...results.map(result => result.name.length));

  console.log("micro benchmark");
  console.log(`node ${process.version}`);
  console.log("");
  console.log([
    "case".padEnd(nameWidth),
    "ops/sec".padStart(14),
    "us/op".padStart(10),
    "total ms".padStart(10)
  ].join("  "));
  console.log([
    "-".repeat(nameWidth),
    "-".repeat(14),
    "-".repeat(10),
    "-".repeat(10)
  ].join("  "));

  for (const result of results) {
    console.log([
      result.name.padEnd(nameWidth),
      formatNumber(result.opsPerSecond).padStart(14),
      result.microsecondsPerOp.toFixed(3).padStart(10),
      result.elapsedMs.toFixed(1).padStart(10)
    ].join("  "));
  }
}

function main() {
  const iterations = Number(process.env.BENCH_ITERATIONS || DEFAULT_ITERATIONS);
  const registry = createRegistry();
  const customCacheRegistry = createRegistry({ compiledSqlCacheSize: 8192 });
  const adapter = new SqlRegistryAdapter(registry);
  const customCacheAdapter = new SqlRegistryAdapter(customCacheRegistry);

  const staticParams = { id: 42, unused: true };
  const dynamicOptions = {
    params: {
      tenantId: 7,
      name: "%alice%",
      active: true,
      limit: 25,
      offset: 50
    },
    context: {
      sort: "createdAt"
    }
  };

  const results = [
    benchmark("registry.bind static", iterations, i => {
      registry.bind("users.findById", { id: (i % 1000) + 1 });
    }),
    benchmark("registry.bind static custom cache", iterations, i => {
      customCacheRegistry.bind("users.findById", { id: (i % 1000) + 1 });
    }),
    benchmark("registry.bind static per-call cache", iterations, i => {
      registry.bind(
        "users.findById",
        { id: (i % 1000) + 1 },
        { compiledSqlCacheSize: 8192 }
      );
    }),
    benchmark("adapter.build static", iterations, i => {
      staticParams.id = (i % 1000) + 1;
      adapter.build("users.findById", { params: staticParams });
    }),
    benchmark("adapter.build static custom cache", iterations, i => {
      staticParams.id = (i % 1000) + 1;
      customCacheAdapter.build("users.findById", { params: staticParams });
    }),
    benchmark("registry.builder dynamic", iterations, i => {
      dynamicOptions.params.limit = (i % 50) + 1;
      registry.builder("users.search", dynamicOptions).build();
    }),
    benchmark("registry.builder dynamic custom cache", iterations, i => {
      dynamicOptions.params.limit = (i % 50) + 1;
      customCacheRegistry.builder("users.search", dynamicOptions).build();
    }),
    benchmark("adapter.build dynamic", iterations, i => {
      dynamicOptions.params.offset = i % 100;
      adapter.build("users.search", dynamicOptions);
    }),
    benchmark("adapter.build dynamic custom cache", iterations, i => {
      dynamicOptions.params.offset = i % 100;
      customCacheAdapter.build("users.search", dynamicOptions);
    })
  ];

  printResults(results);
}

main();
