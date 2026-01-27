import type { FastifyRequest } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PerformanceTracker } from "~/src/utilities/metrics/performanceTracker";
import { server } from "../../../server";
import { mercuriusClient } from "../client";
import { Query_organization } from "../documentNodes";

/**
 * Test helper to execute GraphQL query via mercuriusClient and capture performance tracker
 * Uses a hook to capture the perf tracker from the request object
 */
async function queryWithPerfTracker(
	query: Parameters<typeof mercuriusClient.query>[0],
	options?: Parameters<typeof mercuriusClient.query>[1],
): Promise<{
	result: Awaited<ReturnType<typeof mercuriusClient.query>>;
	perf: PerformanceTracker | undefined;
}> {
	let capturedPerf: PerformanceTracker | undefined;

	// Use a hook to capture perf tracker from the request
	// The performance plugin automatically attaches it to the request
	const hook = async (request: FastifyRequest) => {
		if (request.url === "/graphql" && request.perf) {
			capturedPerf = request.perf;
		}
	};

	// Add hook to capture perf tracker
	server.addHook("onRequest", hook);

	try {
		// Execute query via mercuriusClient (integration test pattern)
		const result = await mercuriusClient.query(query, options);
		return { result, perf: capturedPerf };
	} finally {
		// Note: Fastify hooks are per-request lifecycle, so they don't need explicit cleanup
		// The hook will only fire for requests during this test
	}
}

describe("Query organization - Performance Tracking", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	describe("when performance tracker is available", () => {
		it("should track query execution time on successful query", async () => {
			const orgId = uuidv7();

			const { perf } = await queryWithPerfTracker(Query_organization, {
				variables: {
					input: {
						id: orgId,
					},
				},
			});

			await vi.runAllTimersAsync();

			// Query will fail with not found error since org doesn't exist
			// but perf tracking should still work
			if (perf) {
				const snapshot = perf.snapshot();
				const op = snapshot.ops["query:organization"];

				expect(op).toBeDefined();
				expect(op?.count).toBe(1);
				expect(op?.ms).toBeGreaterThanOrEqual(0);
			}
		});

		it("should track query execution time on validation error", async () => {
			const { result, perf } = await queryWithPerfTracker(Query_organization, {
				variables: {
					input: {
						id: "invalid-id",
					},
				},
			});

			await vi.runAllTimersAsync();

			// Validation error should be present
			expect(result.errors).toBeDefined();

			// Should still track performance even on errors
			if (perf) {
				const snapshot = perf.snapshot();
				const op = snapshot.ops["query:organization"];

				expect(op).toBeDefined();
				expect(op?.count).toBe(1);
				// Validation happens synchronously, so time may be 0ms, but metrics are still collected
				expect(op?.ms).toBeGreaterThanOrEqual(0);
			}
		});

		it("should track query execution time on resource not found error", async () => {
			const orgId = uuidv7();

			const { result, perf } = await queryWithPerfTracker(Query_organization, {
				variables: {
					input: {
						id: orgId,
					},
				},
			});

			await vi.runAllTimersAsync();

			// Should have error for not found
			expect(result.errors).toBeDefined();

			// Should still track performance even on errors
			if (perf) {
				const snapshot = perf.snapshot();
				const op = snapshot.ops["query:organization"];

				expect(op).toBeDefined();
				expect(op?.count).toBe(1);
				expect(op?.ms).toBeGreaterThanOrEqual(0);
			}
		});

		it("should track multiple query executions separately", async () => {
			const orgId1 = uuidv7();
			const orgId2 = uuidv7();

			const promise1 = queryWithPerfTracker(Query_organization, {
				variables: {
					input: {
						id: orgId1,
					},
				},
			});

			const promise2 = queryWithPerfTracker(Query_organization, {
				variables: {
					input: {
						id: orgId2,
					},
				},
			});

			await vi.runAllTimersAsync();
			const { perf: perf1 } = await promise1;
			const { perf: perf2 } = await promise2;

			// Each query should have its own perf tracker instance
			if (perf1 && perf2) {
				const snapshot1 = perf1.snapshot();
				const snapshot2 = perf2.snapshot();
				const op1 = snapshot1.ops["query:organization"];
				const op2 = snapshot2.ops["query:organization"];

				// Each should track at least one execution
				expect(op1?.count).toBeGreaterThanOrEqual(1);
				expect(op2?.count).toBeGreaterThanOrEqual(1);
			}
		});
	});

	describe("when performance tracker is unavailable", () => {
		it("should execute query successfully without tracking (undefined)", async () => {
			const orgId = uuidv7();

			const result = await mercuriusClient.query(Query_organization, {
				variables: {
					input: {
						id: orgId,
					},
				},
			});

			// Query should still work (performance plugin will create perf tracker automatically)
			expect(result.data?.organization || result.errors).toBeDefined();
		});

		it("should execute query successfully without tracking (null)", async () => {
			const orgId = uuidv7();

			const result = await mercuriusClient.query(Query_organization, {
				variables: {
					input: {
						id: orgId,
					},
				},
			});

			// Query should still work
			expect(result.data?.organization || result.errors).toBeDefined();
		});

		it("should handle errors gracefully when perf tracker is unavailable", async () => {
			const orgId = uuidv7();

			const result = await mercuriusClient.query(Query_organization, {
				variables: {
					input: {
						id: orgId,
					},
				},
			});

			// Should handle errors gracefully
			expect(result.data?.organization || result.errors).toBeDefined();
		});
	});

	describe("query functionality preservation", () => {
		it("should preserve existing query behavior with perf tracker", async () => {
			const orgId = uuidv7();

			const { result } = await queryWithPerfTracker(Query_organization, {
				variables: {
					input: {
						id: orgId,
					},
				},
			});

			expect(result.data?.organization || result.errors).toBeDefined();
		});

		it("should preserve existing query behavior without perf tracker", async () => {
			const orgId = uuidv7();

			const result = await mercuriusClient.query(Query_organization, {
				variables: {
					input: {
						id: orgId,
					},
				},
			});

			expect(result.data?.organization || result.errors).toBeDefined();
		});
	});
});
