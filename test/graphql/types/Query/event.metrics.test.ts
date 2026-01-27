import { faker } from "@faker-js/faker";
import type { FastifyRequest } from "fastify";
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
import { assertToBeNonNullish } from "../../../helpers";
import { server } from "../../../server";
import { mercuriusClient } from "../client";
import {
	Mutation_createEvent,
	Mutation_createOrganization,
	Mutation_createOrganizationMembership,
	Mutation_createUser,
	Mutation_deleteOrganization,
	Mutation_deleteUser,
	Query_event,
	Query_signIn,
} from "../documentNodes";

/**
 * Type for event query result
 */
interface EventQueryResult extends Record<string, unknown> {
	event?: {
		id: string;
		name: string;
		description: string | null;
		startAt: string;
		endAt: string;
		isInviteOnly: boolean;
		creator?: {
			id: string;
			name: string;
		};
		organization?: {
			id: string;
			countryCode: string;
		};
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

describe("Query event - Performance Tracking", () => {
	let adminAuth = "";
	let createdUserId = "";
	let createdOrganizationId = "";
	let createdEventId = "";

	beforeAll(async () => {
		vi.useFakeTimers();

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
		const createdUserEmail = `email${faker.string.ulid()}@email.com`;
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

		// Create an organization
		const createOrgResult = await mercuriusClient.mutate(
			Mutation_createOrganization,
			{
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
				variables: {
					input: {
						name: "Test Organization",
						countryCode: "us",
					},
				},
			},
		);
		assertToBeNonNullish(createOrgResult.data.createOrganization?.id);
		createdOrganizationId = createOrgResult.data.createOrganization.id;

		// Add user as member of organization
		await mercuriusClient.mutate(Mutation_createOrganizationMembership, {
			headers: {
				authorization: `bearer ${adminAuth}`,
			},
			variables: {
				input: {
					memberId: createdUserId,
					organizationId: createdOrganizationId,
					role: "administrator",
				},
			},
		});

		// Create an event
		const startAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
		const endAt = new Date(startAt.getTime() + 2 * 60 * 60 * 1000); // 2 hours later
		const createEventResult = await mercuriusClient.mutate(
			Mutation_createEvent,
			{
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
				variables: {
					input: {
						name: "Test Event",
						description: "Test Event Description",
						organizationId: createdOrganizationId,
						startAt: startAt.toISOString(),
						endAt: endAt.toISOString(),
						isPublic: true,
						isRegisterable: true,
					},
				},
			},
		);
		assertToBeNonNullish(createEventResult.data.createEvent?.id);
		createdEventId = createEventResult.data.createEvent.id;
	});

	afterAll(async () => {
		// Clean up created resources
		if (createdOrganizationId) {
			await mercuriusClient.mutate(Mutation_deleteOrganization, {
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
				variables: {
					input: {
						id: createdOrganizationId,
					},
				},
			});
		}
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
		vi.useRealTimers();
	});

	beforeEach(() => {
		// Clear captured perf trackers between tests
		capturedPerfTrackers.length = 0;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("when performance tracker is available", () => {
		it("should track query execution time on successful query", async () => {
			const { result, perf } = await queryWithPerfTracker<EventQueryResult>(
				Query_event,
				{
					headers: {
						authorization: `bearer ${adminAuth}`,
					},
					variables: {
						input: {
							id: createdEventId,
						},
					},
				},
			);

			await vi.runAllTimersAsync();

			expect(result.errors).toBeUndefined();
			const data = result.data as EventQueryResult;
			expect(data?.event?.id).toBe(createdEventId);
			expect(perf).toBeDefined();

			const snapshot = perf?.snapshot();
			assertToBeNonNullish(snapshot);
			const op = snapshot.ops["query:event"];

			expect(op).toBeDefined();
			expect(op?.count).toBe(1);
			expect(op?.ms).toBeGreaterThanOrEqual(0);
		});

		it("should track query execution time on unauthenticated error", async () => {
			const { result, perf } = await queryWithPerfTracker<EventQueryResult>(
				Query_event,
				{
					// No authorization header - should trigger unauthenticated error
					variables: {
						input: {
							id: createdEventId,
						},
					},
				},
			);

			await vi.runAllTimersAsync();

			expect(result.errors).toBeDefined();
			expect(result.errors?.[0]?.extensions?.code).toMatch(
				/unauthorized|unauthenticated/i,
			);
			expect(perf).toBeDefined();

			const snapshot = perf?.snapshot();
			assertToBeNonNullish(snapshot);
			const op = snapshot.ops["query:event"];

			expect(op).toBeDefined();
			expect(op?.count).toBe(1);
			expect(op?.ms).toBeGreaterThanOrEqual(0);
		});

		it("should track query execution time on validation error", async () => {
			const { result, perf } = await queryWithPerfTracker<EventQueryResult>(
				Query_event,
				{
					headers: {
						authorization: `bearer ${adminAuth}`,
					},
					variables: {
						input: {
							id: "invalid-id-format",
						},
					},
				},
			);

			await vi.runAllTimersAsync();

			expect(result.errors).toBeDefined();
			expect(perf).toBeDefined();

			const snapshot = perf?.snapshot();
			assertToBeNonNullish(snapshot);
			const op = snapshot.ops["query:event"];

			expect(op).toBeDefined();
			expect(op?.count).toBe(1);
			expect(op?.ms).toBeGreaterThanOrEqual(0);
		});

		it("should track query execution time on resource not found error", async () => {
			// Use a non-existent event ID
			const nonExistentEventId = faker.string.ulid();

			const { result, perf } = await queryWithPerfTracker<EventQueryResult>(
				Query_event,
				{
					headers: {
						authorization: `bearer ${adminAuth}`,
					},
					variables: {
						input: {
							id: nonExistentEventId,
						},
					},
				},
			);

			await vi.runAllTimersAsync();

			expect(result.errors).toBeDefined();
			expect(perf).toBeDefined();

			const snapshot = perf?.snapshot();
			assertToBeNonNullish(snapshot);
			const op = snapshot.ops["query:event"];

			expect(op).toBeDefined();
			expect(op?.count).toBe(1);
			expect(op?.ms).toBeGreaterThanOrEqual(0);
		});

		it("should track multiple query executions separately", async () => {
			const { perf: perf1 } = await queryWithPerfTracker<EventQueryResult>(
				Query_event,
				{
					headers: {
						authorization: `bearer ${adminAuth}`,
					},
					variables: {
						input: {
							id: createdEventId,
						},
					},
				},
			);

			await vi.runAllTimersAsync();

			const { perf: perf2 } = await queryWithPerfTracker<EventQueryResult>(
				Query_event,
				{
					headers: {
						authorization: `bearer ${adminAuth}`,
					},
					variables: {
						input: {
							id: createdEventId,
						},
					},
				},
			);

			await vi.runAllTimersAsync();

			expect(perf1).toBeDefined();
			expect(perf2).toBeDefined();

			const snapshot1 = perf1?.snapshot();
			const snapshot2 = perf2?.snapshot();
			assertToBeNonNullish(snapshot1);
			assertToBeNonNullish(snapshot2);

			const op1 = snapshot1.ops["query:event"];
			const op2 = snapshot2.ops["query:event"];

			expect(op1).toBeDefined();
			expect(op1?.count).toBe(1);
			expect(op2).toBeDefined();
			expect(op2?.count).toBe(1);
		});
	});

	describe("when performance tracker is unavailable", () => {
		beforeEach(() => {
			// Add a hook to disable perf tracker for GraphQL requests
			const disablePerfHook = async (request: FastifyRequest) => {
				if (request.url === "/graphql") {
					request.perf = undefined;
				}
			};
			server.addHook("onRequest", disablePerfHook);
		});

		it("should execute query successfully without tracking", async () => {
			const result = await mercuriusClient.query(Query_event, {
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
				variables: {
					input: {
						id: createdEventId,
					},
				},
			});

			await vi.runAllTimersAsync();

			expect(result.errors).toBeUndefined();
			const data = result.data as EventQueryResult;
			expect(data?.event?.id).toBe(createdEventId);
		});

		it("should handle errors gracefully when perf tracker is unavailable", async () => {
			const result = await mercuriusClient.query(Query_event, {
				// No authorization header - should trigger unauthenticated error
				variables: {
					input: {
						id: createdEventId,
					},
				},
			});

			await vi.runAllTimersAsync();

			expect(result.errors).toBeDefined();
			expect(result.errors?.[0]?.extensions?.code).toMatch(
				/unauthorized|unauthenticated/i,
			);
		});
	});
});
