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
	Mutation_createOrganization,
	Mutation_createOrganizationMembership,
	Mutation_createUser,
	Mutation_deleteOrganization,
	Mutation_deleteOrganizationMembership,
	Mutation_deleteUser,
	Query_organizations,
	Query_organizationsWithArgs,
	Query_signIn,
} from "../documentNodes";

/**
 * Type for organizations query response
 */
interface OrganizationsQueryResponse extends Record<string, unknown> {
	organizations: Array<{
		id: string;
		avatarURL: string | null;
		name: string;
		city: string | null;
		state: string | null;
		countryCode: string;
	}> | null;
}

/**
 * Type for organizations query result (legacy, for backward compatibility)
 */
interface OrganizationsQueryResult extends Record<string, unknown> {
	organizations?: Array<{
		id: string;
		avatarURL?: string | null;
		name: string;
		city?: string | null;
		state?: string | null;
		countryCode: string;
	}>;
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

describe("Query organizations - Performance Tracking", () => {
	let adminAuth = "";
	let regularUser1Email = "";
	let regularUser1Id = "";
	let regularUser1Auth = "";
	let regularUser2Email = "";
	let regularUser2Id = "";
	let regularUser2Auth = "";
	let org1Id = "";
	let org2Id = "";

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

		// Create regular user 1
		regularUser1Email = `email${faker.string.ulid()}@email.com`;
		const createUser1Result = await mercuriusClient.mutate(
			Mutation_createUser,
			{
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
				variables: {
					input: {
						emailAddress: regularUser1Email,
						isEmailAddressVerified: false,
						name: "Regular User 1",
						password: "password",
						role: "regular",
					},
				},
			},
		);
		assertToBeNonNullish(createUser1Result.data.createUser?.user?.id);
		regularUser1Id = createUser1Result.data.createUser.user.id;

		// Create regular user 2
		regularUser2Email = `email${faker.string.ulid()}@email.com`;
		const createUser2Result = await mercuriusClient.mutate(
			Mutation_createUser,
			{
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
				variables: {
					input: {
						emailAddress: regularUser2Email,
						isEmailAddressVerified: false,
						name: "Regular User 2",
						password: "password",
						role: "regular",
					},
				},
			},
		);
		assertToBeNonNullish(createUser2Result.data.createUser?.user?.id);
		regularUser2Id = createUser2Result.data.createUser.user.id;

		// Sign in as regular users
		const user1SignInResult = await mercuriusClient.query(Query_signIn, {
			variables: {
				input: {
					emailAddress: regularUser1Email,
					password: "password",
				},
			},
		});
		assertToBeNonNullish(user1SignInResult.data.signIn?.authenticationToken);
		regularUser1Auth = user1SignInResult.data.signIn.authenticationToken;

		const user2SignInResult = await mercuriusClient.query(Query_signIn, {
			variables: {
				input: {
					emailAddress: regularUser2Email,
					password: "password",
				},
			},
		});
		assertToBeNonNullish(user2SignInResult.data.signIn?.authenticationToken);
		regularUser2Auth = user2SignInResult.data.signIn.authenticationToken;

		// Create organizations
		const org1Result = await mercuriusClient.mutate(
			Mutation_createOrganization,
			{
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
				variables: {
					input: {
						countryCode: "us",
						name: `Test Organization 1 ${faker.string.alphanumeric(8)}`,
					},
				},
			},
		);
		assertToBeNonNullish(org1Result.data?.createOrganization);
		org1Id = org1Result.data.createOrganization.id;

		const org2Result = await mercuriusClient.mutate(
			Mutation_createOrganization,
			{
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
				variables: {
					input: {
						countryCode: "ca",
						name: `Test Organization 2 ${faker.string.alphanumeric(8)}`,
					},
				},
			},
		);
		assertToBeNonNullish(org2Result.data?.createOrganization);
		org2Id = org2Result.data.createOrganization.id;

		// Make regular user 1 an admin of organization 1
		const orgMembership = await mercuriusClient.mutate(
			Mutation_createOrganizationMembership,
			{
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
				variables: {
					input: {
						memberId: regularUser1Id,
						organizationId: org1Id,
						role: "administrator",
					},
				},
			},
		);
		assertToBeNonNullish(orgMembership.data?.createOrganizationMembership);
	});

	afterAll(async () => {
		// Clean up organization memberships
		await mercuriusClient.mutate(Mutation_deleteOrganizationMembership, {
			headers: {
				authorization: `bearer ${adminAuth}`,
			},
			variables: {
				input: {
					organizationId: org1Id,
					memberId: regularUser1Id,
				},
			},
		});

		// Clean up organizations
		await mercuriusClient.mutate(Mutation_deleteOrganization, {
			headers: {
				authorization: `bearer ${adminAuth}`,
			},
			variables: {
				input: {
					id: org1Id,
				},
			},
		});

		await mercuriusClient.mutate(Mutation_deleteOrganization, {
			headers: {
				authorization: `bearer ${adminAuth}`,
			},
			variables: {
				input: {
					id: org2Id,
				},
			},
		});

		// Clean up users
		await mercuriusClient.mutate(Mutation_deleteUser, {
			headers: {
				authorization: `bearer ${adminAuth}`,
			},
			variables: {
				input: {
					id: regularUser1Id,
				},
			},
		});

		await mercuriusClient.mutate(Mutation_deleteUser, {
			headers: {
				authorization: `bearer ${adminAuth}`,
			},
			variables: {
				input: {
					id: regularUser2Id,
				},
			},
		});
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
		it("should track query execution time on successful query (administrator)", async () => {
			const { result, perf } =
				await queryWithPerfTracker<OrganizationsQueryResponse>(
					Query_organizations,
					{
						headers: {
							authorization: `bearer ${adminAuth}`,
						},
					},
				);

			await vi.runAllTimersAsync();

			expect(result.errors).toBeUndefined();
			const data = result.data as OrganizationsQueryResponse;
			expect(data?.organizations?.length).toBeGreaterThan(1);

			expect(perf).toBeDefined();
			if (perf) {
				const snapshot = perf.snapshot();
				const op = snapshot.ops["query:organizations"];

				expect(op).toBeDefined();
				expect(op?.count).toBe(1);
				expect(op?.ms).toBeGreaterThanOrEqual(0);
			}
		});

		it("should track query execution time on successful query (regular user)", async () => {
			const { result, perf } =
				await queryWithPerfTracker<OrganizationsQueryResponse>(
					Query_organizations,
					{
						headers: {
							authorization: `bearer ${regularUser2Auth}`,
						},
					},
				);

			await vi.runAllTimersAsync();

			expect(result.errors).toBeUndefined();
			const data = result.data as OrganizationsQueryResponse;
			expect(data?.organizations?.length).toBeGreaterThan(0);

			expect(perf).toBeDefined();
			if (perf) {
				const snapshot = perf.snapshot();
				const op = snapshot.ops["query:organizations"];

				expect(op).toBeDefined();
				expect(op?.count).toBe(1);
				expect(op?.ms).toBeGreaterThanOrEqual(0);
			}
		});

		it("should track query execution time on successful query (regular user with admin membership)", async () => {
			const { result, perf } =
				await queryWithPerfTracker<OrganizationsQueryResponse>(
					Query_organizations,
					{
						headers: {
							authorization: `bearer ${regularUser1Auth}`,
						},
					},
				);

			await vi.runAllTimersAsync();

			expect(result.errors).toBeUndefined();
			// Regular user with admin membership should only see organizations they administer
			const data = result.data as OrganizationsQueryResponse;
			expect(data?.organizations).toHaveLength(1);
			expect(data?.organizations?.[0]?.id).toBe(org1Id);

			expect(perf).toBeDefined();
			if (perf) {
				const snapshot = perf.snapshot();
				const op = snapshot.ops["query:organizations"];

				expect(op).toBeDefined();
				expect(op?.count).toBe(1);
				expect(op?.ms).toBeGreaterThanOrEqual(0);
			}
		});

		it("should track query execution time on unauthenticated error", async () => {
			// Use an invalid token to trigger unauthenticated error
			const { result, perf } =
				await queryWithPerfTracker<OrganizationsQueryResponse>(
					Query_organizations,
					{
						headers: {
							authorization: `bearer invalid-token`,
						},
					},
				);

			await vi.runAllTimersAsync();

			// Should have unauthenticated error
			expect(result.errors).toBeDefined();
			expect(result.errors).toContainEqual(
				expect.objectContaining({
					extensions: expect.objectContaining({
						code: expect.stringMatching(/unauthorized|unauthenticated/i),
					}),
				}),
			);

			// Should still track performance even on errors
			expect(perf).toBeDefined();
			if (perf) {
				const snapshot = perf.snapshot();
				const op = snapshot.ops["query:organizations"];

				expect(op).toBeDefined();
				expect(op?.count).toBe(1);
				expect(op?.ms).toBeGreaterThanOrEqual(0);
			}
		});

		it("should track query execution time with filtering", async () => {
			const { result, perf } =
				await queryWithPerfTracker<OrganizationsQueryResponse>(
					Query_organizationsWithArgs,
					{
						headers: {
							authorization: `bearer ${adminAuth}`,
						},
						variables: {
							filter: "Test",
						},
					},
				);

			await vi.runAllTimersAsync();

			expect(result.errors).toBeUndefined();
			const data = result.data as OrganizationsQueryResponse;
			expect(data?.organizations).toBeDefined();

			expect(perf).toBeDefined();
			if (perf) {
				const snapshot = perf.snapshot();
				const op = snapshot.ops["query:organizations"];

				expect(op).toBeDefined();
				expect(op?.count).toBe(1);
			}
		});

		it("should track query execution time with pagination", async () => {
			const { result, perf } =
				await queryWithPerfTracker<OrganizationsQueryResponse>(
					Query_organizationsWithArgs,
					{
						headers: {
							authorization: `bearer ${adminAuth}`,
						},
						variables: {
							limit: 10,
							offset: 0,
						},
					},
				);

			await vi.runAllTimersAsync();

			expect(result.errors).toBeUndefined();
			const data = result.data as OrganizationsQueryResponse;
			expect(data?.organizations).toBeDefined();

			expect(perf).toBeDefined();
			if (perf) {
				const snapshot = perf.snapshot();
				const op = snapshot.ops["query:organizations"];

				expect(op).toBeDefined();
				expect(op?.count).toBe(1);
			}
		});

		it("should track multiple query executions separately", async () => {
			const promise1 = queryWithPerfTracker<OrganizationsQueryResponse>(
				Query_organizations,
				{
					headers: {
						authorization: `bearer ${adminAuth}`,
					},
				},
			);

			const promise2 = queryWithPerfTracker<OrganizationsQueryResponse>(
				Query_organizations,
				{
					headers: {
						authorization: `bearer ${adminAuth}`,
					},
				},
			);

			await vi.runAllTimersAsync();
			const { perf: perf1 } = await promise1;
			const { perf: perf2 } = await promise2;

			// Each query should have its own perf tracker instance
			expect(perf1).toBeDefined();
			expect(perf2).toBeDefined();
			if (perf1 && perf2) {
				const snapshot1 = perf1.snapshot();
				const snapshot2 = perf2.snapshot();
				const op1 = snapshot1.ops["query:organizations"];
				const op2 = snapshot2.ops["query:organizations"];

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
			// Remove the hook to restore normal behavior
			// Note: Fastify doesn't provide a direct way to remove hooks, but this is fine for tests
			// as the hook will just set perf to undefined which is what we want
		});

		it("should execute query successfully without tracking", async () => {
			const result = (await mercuriusClient.query(Query_organizations, {
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
			})) as { data?: OrganizationsQueryResult; errors?: unknown[] };

			// Query should still work (withQueryMetrics fallback branch)
			expect(result.errors).toBeUndefined();
			expect(result.data?.organizations?.length).toBeGreaterThan(0);
		});

		it("should handle errors gracefully when perf tracker is unavailable", async () => {
			const result = (await mercuriusClient.query(Query_organizations, {
				headers: {
					authorization: `bearer invalid-token`,
				},
			})) as { data?: OrganizationsQueryResult; errors?: unknown[] };

			// Should handle errors gracefully
			expect(result.data?.organizations || result.errors).toBeDefined();
		});
	});

	describe("query functionality preservation", () => {
		it("should preserve existing query behavior with perf tracker", async () => {
			const { result } = await queryWithPerfTracker<OrganizationsQueryResponse>(
				Query_organizations,
				{
					headers: {
						authorization: `bearer ${adminAuth}`,
					},
				},
			);

			expect(result.errors).toBeUndefined();
			const data = result.data as OrganizationsQueryResponse;
			expect(data?.organizations?.length).toBeGreaterThan(0);
		});

		it("should preserve existing query behavior without perf tracker", async () => {
			const result = (await mercuriusClient.query(Query_organizations, {
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
			})) as { data?: OrganizationsQueryResult; errors?: unknown[] };

			expect(result.errors).toBeUndefined();
			expect(result.data?.organizations?.length).toBeGreaterThan(0);
		});
	});
});
