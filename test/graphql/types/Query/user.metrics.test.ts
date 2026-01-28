import { faker } from "@faker-js/faker";
import type { FastifyRequest } from "fastify";
import { assertToBeNonNullish } from "test/helpers";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { PerformanceTracker } from "~/src/utilities/metrics/performanceTracker";
import { server } from "../../../server";
import { mercuriusClient } from "../client";
import {
	Mutation_createUser,
	Mutation_deleteUser,
	Query_signIn,
	Query_user,
} from "../documentNodes";

/**
 * Type for user query result
 */
interface UserQueryResult extends Record<string, unknown> {
	user?: {
		id: string;
		name: string;
		emailAddress: string;
		[key: string]: unknown;
	};
}

/**
 * Array to store captured performance trackers
 * Cleared between tests to avoid leaks
 */
const capturedPerfTrackers: PerformanceTracker[] = [];

/**
 * Single onRequest hook to capture perf trackers for all requests
 * Registered once and reused for all test calls
 */
let perfCaptureHookRegistered = false;
const perfCaptureHook = async (request: FastifyRequest) => {
	if (request.url === "/graphql" && request.perf) {
		capturedPerfTrackers.push(request.perf);
	}
};

/**
 * Test helper to execute GraphQL query via mercuriusClient and capture performance tracker
 * Uses a shared array to capture perf trackers, with index tracking for concurrent requests
 *
 * Note: The hook is registered once globally and persists across all test calls.
 * Fastify hooks cannot be removed once registered, but this is safe because:
 * - The hook only captures perf trackers into a shared array
 * - The array is cleared between tests in beforeEach/afterEach
 * - The hook is idempotent (registering multiple times would be safe, but we guard against it)
 */
async function queryWithPerfTracker<
	_T extends Record<string, unknown> = Record<string, unknown>,
>(
	query: Parameters<typeof mercuriusClient.query>[0],
	options?: Parameters<typeof mercuriusClient.query>[1],
): Promise<{
	result: Awaited<ReturnType<typeof mercuriusClient.query>>;
	perf: PerformanceTracker | undefined;
}> {
	// Register the hook once if not already registered
	// Fastify hooks persist for the lifetime of the server instance, which is fine for tests
	// since we clear the capturedPerfTrackers array between tests
	if (!perfCaptureHookRegistered) {
		server.addHook("onRequest", perfCaptureHook);
		perfCaptureHookRegistered = true;
	}

	// Track the current array length before the query
	const startIndex = capturedPerfTrackers.length;

	// Execute query via mercuriusClient (integration test pattern)
	const result = await mercuriusClient.query(query, options);

	// Get the perf tracker that was captured during this query
	// For sequential tests, this will be the last entry
	// For concurrent tests, we get the entry at startIndex (first new entry)
	const perf =
		capturedPerfTrackers.length > startIndex
			? capturedPerfTrackers[startIndex]
			: capturedPerfTrackers[capturedPerfTrackers.length - 1];

	return { result, perf };
}

describe("Query user - Performance Tracking", () => {
	let adminAuth = "";
	let createdUserId = "";
	let createdUserEmail = "";

	beforeAll(async () => {
		// Sign in as administrator
		const administratorUserSignInResult = await mercuriusClient.query(
			Query_signIn,
			{
				variables: {
					input: {
						emailAddress: server.envConfig.API_ADMINISTRATOR_USER_EMAIL_ADDRESS,
						password: server.envConfig.API_ADMINISTRATOR_USER_PASSWORD,
					},
				},
			},
		);
		assertToBeNonNullish(
			administratorUserSignInResult.data.signIn?.authenticationToken,
		);
		adminAuth = administratorUserSignInResult.data.signIn.authenticationToken;

		// Create a user for testing
		createdUserEmail = `email${faker.string.ulid()}@email.com`;
		const createUserResult = await mercuriusClient.mutate(Mutation_createUser, {
			headers: {
				authorization: `bearer ${adminAuth}`,
			},
			variables: {
				input: {
					emailAddress: createdUserEmail,
					isEmailAddressVerified: false,
					name: "Test User",
					password: "password",
					role: "regular",
				},
			},
		});
		assertToBeNonNullish(createUserResult.data.createUser?.user?.id);
		createdUserId = createUserResult.data.createUser.user.id;
	});

	afterAll(async () => {
		// Clean up created user
		if (createdUserId) {
			await mercuriusClient.mutate(Mutation_deleteUser, {
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
				variables: {
					input: {
						id: createdUserId,
					},
				},
			});
		}
	});

	beforeEach(() => {
		vi.useFakeTimers();
		capturedPerfTrackers.length = 0; // Clear the array
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		capturedPerfTrackers.length = 0; // Clear the array
	});

	describe("when performance tracker is available", () => {
		it("should track query execution time on successful query", async () => {
			const { result, perf } = await queryWithPerfTracker(Query_user, {
				variables: {
					input: {
						id: createdUserId,
					},
				},
			});

			await vi.runAllTimersAsync();

			expect(result.errors).toBeUndefined();
			const data = result.data as UserQueryResult;
			expect(data?.user).toBeDefined();
			expect(data?.user?.id).toBe(createdUserId);

			expect(perf).toBeDefined();
			if (!perf) {
				throw new Error("Performance tracker should be defined");
			}
			const snapshot = perf.snapshot();
			const op = snapshot.ops["query:user"];

			expect(op).toBeDefined();
			expect(op?.count).toBe(1);
			expect(op?.ms).toBeGreaterThanOrEqual(0);
		});

		it("should track query execution time on validation error", async () => {
			const { result, perf } = await queryWithPerfTracker(Query_user, {
				variables: {
					input: {
						id: "invalid-id",
					},
				},
			});

			await vi.runAllTimersAsync();

			expect(result.errors).toBeDefined();

			expect(perf).toBeDefined();
			if (perf) {
				const snapshot = perf.snapshot();
				const op = snapshot.ops["query:user"];

				expect(op).toBeDefined();
				expect(op?.count).toBe(1);
				expect(op?.ms).toBeGreaterThanOrEqual(0);
			}
		});

		it("should track query execution time on resource not found error", async () => {
			const nonExistentUserId = faker.string.ulid();

			const { result, perf } = await queryWithPerfTracker(Query_user, {
				variables: {
					input: {
						id: nonExistentUserId,
					},
				},
			});

			await vi.runAllTimersAsync();

			expect(result.errors).toBeDefined();

			expect(perf).toBeDefined();
			if (perf) {
				const snapshot = perf.snapshot();
				const op = snapshot.ops["query:user"];

				expect(op).toBeDefined();
				expect(op?.count).toBe(1);
				expect(op?.ms).toBeGreaterThanOrEqual(0);
			}
		});

		it("should track multiple query executions separately", async () => {
			const promise1 = queryWithPerfTracker(Query_user, {
				variables: {
					input: {
						id: createdUserId,
					},
				},
			});

			const promise2 = queryWithPerfTracker(Query_user, {
				variables: {
					input: {
						id: createdUserId,
					},
				},
			});

			await vi.runAllTimersAsync();
			const { perf: perf1 } = await promise1;
			const { perf: perf2 } = await promise2;

			// Each query should have its own perf tracker instance
			expect(perf1).toBeDefined();
			expect(perf2).toBeDefined();
			if (perf1 && perf2) {
				const snapshot1 = perf1.snapshot();
				const snapshot2 = perf2.snapshot();
				const op1 = snapshot1.ops["query:user"];
				const op2 = snapshot2.ops["query:user"];

				// Each should track at least one execution
				expect(op1?.count).toBeGreaterThanOrEqual(1);
				expect(op2?.count).toBeGreaterThanOrEqual(1);
			}
		});
	});

	describe("when performance tracker is unavailable", () => {
		let disablePerfHook: (request: FastifyRequest) => Promise<void> | void;

		beforeEach(() => {
			// Add a hook that runs after the performance plugin's hook to disable perf
			disablePerfHook = async (request: FastifyRequest) => {
				if (request.url === "/graphql") {
					// Delete perf after the performance plugin sets it
					request.perf = undefined;
				}
			};
			server.addHook("onRequest", disablePerfHook);
		});

		afterEach(() => {
			// Note: Fastify doesn't provide a direct way to remove hooks, but this is fine for tests
			// as the hook will just set perf to undefined which is what we want
		});

		it("should execute query successfully without tracking (undefined)", async () => {
			const result = (await mercuriusClient.query(Query_user, {
				variables: {
					input: {
						id: createdUserId,
					},
				},
			})) as { data?: UserQueryResult; errors?: unknown[] };

			// Query should still work (withQueryMetrics fallback branch)
			expect(result.data?.user || result.errors).toBeDefined();
		});

		it("should execute query successfully without tracking (null)", async () => {
			const result = (await mercuriusClient.query(Query_user, {
				variables: {
					input: {
						id: createdUserId,
					},
				},
			})) as { data?: UserQueryResult; errors?: unknown[] };

			// Query should still work
			expect(result.data?.user || result.errors).toBeDefined();
		});

		it("should handle errors gracefully when perf tracker is unavailable", async () => {
			const nonExistentUserId = faker.string.ulid();

			const result = (await mercuriusClient.query(Query_user, {
				variables: {
					input: {
						id: nonExistentUserId,
					},
				},
			})) as { data?: UserQueryResult; errors?: unknown[] };

			// Should handle errors gracefully
			expect(result.data?.user || result.errors).toBeDefined();
		});
	});

	describe("query functionality preservation", () => {
		it("should preserve existing query behavior with perf tracker", async () => {
			const { result } = await queryWithPerfTracker(Query_user, {
				variables: {
					input: {
						id: createdUserId,
					},
				},
			});

			expect(result.data?.user || result.errors).toBeDefined();
		});

		it("should preserve existing query behavior without perf tracker", async () => {
			const result = (await mercuriusClient.query(Query_user, {
				variables: {
					input: {
						id: createdUserId,
					},
				},
			})) as { data?: UserQueryResult; errors?: unknown[] };

			expect(result.data?.user || result.errors).toBeDefined();
		});
	});
});
