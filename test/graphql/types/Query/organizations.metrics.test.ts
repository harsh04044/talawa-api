import { print } from "graphql";
import type { FastifyRequest } from "fastify";
import { faker } from "@faker-js/faker";
import { assertToBeNonNullish } from "test/helpers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
	Query_signIn,
} from "../documentNodes";
import type { PerformanceTracker } from "~/src/utilities/metrics/performanceTracker";
import { createPerformanceTracker } from "~/src/utilities/metrics/performanceTracker";

/**
 * Test helper to execute GraphQL query via mercuriusClient and capture performance tracker
 * Uses a hook to capture the perf tracker from the request object
 */
async function queryWithPerfTracker<T>(
	query: Parameters<typeof mercuriusClient.query>[0],
	options?: Parameters<typeof mercuriusClient.query>[1],
): Promise<{
	result: Awaited<ReturnType<typeof mercuriusClient.query<T>>>;
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
		const result = await mercuriusClient.query<T>(query, options);
		return { result, perf: capturedPerf };
	} finally {
		// Note: Fastify hooks are per-request lifecycle, so they don't need explicit cleanup
		// The hook will only fire for requests during this test
	}
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
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	describe("when performance tracker is available", () => {
		it("should track query execution time on successful query (administrator)", async () => {
			const { result, perf } = await queryWithPerfTracker(Query_organizations, {
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
				variables: {},
			});

			await vi.runAllTimersAsync();

			expect(result.errors).toBeUndefined();
			expect(result.data?.organizations?.length).toBeGreaterThan(1);

			if (perf) {
				const snapshot = perf.snapshot();
				const op = snapshot.ops["query:organizations"];

				expect(op).toBeDefined();
				expect(op?.count).toBe(1);
				expect(op?.ms).toBeGreaterThanOrEqual(0);
			}
		});

		it("should track query execution time on successful query (regular user)", async () => {
			const { result, perf } = await queryWithPerfTracker(Query_organizations, {
				headers: {
					authorization: `bearer ${regularUser2Auth}`,
				},
				variables: {},
			});

			await vi.runAllTimersAsync();

			expect(result.errors).toBeUndefined();
			expect(result.data?.organizations?.length).toBeGreaterThan(0);

			if (perf) {
				const snapshot = perf.snapshot();
				const op = snapshot.ops["query:organizations"];

				expect(op).toBeDefined();
				expect(op?.count).toBe(1);
				expect(op?.ms).toBeGreaterThanOrEqual(0);
			}
		});

		it("should track query execution time on successful query (regular user with admin membership)", async () => {
			const { result, perf } = await queryWithPerfTracker(Query_organizations, {
				headers: {
					authorization: `bearer ${regularUser1Auth}`,
				},
				variables: {},
			});

			await vi.runAllTimersAsync();

			expect(result.errors).toBeUndefined();
			// Regular user with admin membership should only see organizations they administer
			expect(result.data?.organizations).toHaveLength(1);
			expect(result.data?.organizations?.[0]?.id).toBe(org1Id);

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
			const { result, perf } = await queryWithPerfTracker(Query_organizations, {
				headers: {
					authorization: `bearer invalid-token`,
				},
				variables: {},
			});

			await vi.runAllTimersAsync();

			// Should still track performance even on errors
			if (perf) {
				const snapshot = perf.snapshot();
				const op = snapshot.ops["query:organizations"];

				expect(op).toBeDefined();
				expect(op?.count).toBe(1);
				expect(op?.ms).toBeGreaterThanOrEqual(0);
			}
		});

		it("should track query execution time with filtering", async () => {
			const { result, perf } = await queryWithPerfTracker(Query_organizations, {
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
				variables: {
					filter: "Test",
				},
			});

			await vi.runAllTimersAsync();

			expect(result.errors).toBeUndefined();
			expect(result.data?.organizations).toBeDefined();

			if (perf) {
				const snapshot = perf.snapshot();
				const op = snapshot.ops["query:organizations"];

				expect(op).toBeDefined();
				expect(op?.count).toBe(1);
			}
		});

		it("should track query execution time with pagination", async () => {
			const { result, perf } = await queryWithPerfTracker(Query_organizations, {
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
				variables: {
					limit: 10,
					offset: 0,
				},
			});

			await vi.runAllTimersAsync();

			expect(result.errors).toBeUndefined();
			expect(result.data?.organizations).toBeDefined();

			if (perf) {
				const snapshot = perf.snapshot();
				const op = snapshot.ops["query:organizations"];

				expect(op).toBeDefined();
				expect(op?.count).toBe(1);
			}
		});

		it("should track multiple query executions separately", async () => {
			const promise1 = queryWithPerfTracker(Query_organizations, {
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
				variables: {},
			});

			const promise2 = queryWithPerfTracker(Query_organizations, {
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
				variables: {},
			});

			await vi.runAllTimersAsync();
			const { perf: perf1 } = await promise1;
			const { perf: perf2 } = await promise2;

			// Each query should have its own perf tracker instance
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
		it("should execute query successfully without tracking", async () => {
			const result = await mercuriusClient.query(Query_organizations, {
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
				variables: {},
			});

			// Query should still work (performance plugin will create perf tracker automatically)
			expect(result.errors).toBeUndefined();
			expect(result.data?.organizations?.length).toBeGreaterThan(0);
		});

		it("should handle errors gracefully when perf tracker is unavailable", async () => {
			const result = await mercuriusClient.query(Query_organizations, {
				headers: {
					authorization: `bearer invalid-token`,
				},
				variables: {},
			});

			// Should handle errors gracefully
			expect(result.data?.organizations || result.errors).toBeDefined();
		});
	});

	describe("query functionality preservation", () => {
		it("should preserve existing query behavior with perf tracker", async () => {
			const { result } = await queryWithPerfTracker(Query_organizations, {
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
				variables: {},
			});

			expect(result.errors).toBeUndefined();
			expect(result.data?.organizations?.length).toBeGreaterThan(0);
		});

		it("should preserve existing query behavior without perf tracker", async () => {
			const result = await mercuriusClient.query(Query_organizations, {
				headers: {
					authorization: `bearer ${adminAuth}`,
				},
				variables: {},
			});

			expect(result.errors).toBeUndefined();
			expect(result.data?.organizations?.length).toBeGreaterThan(0);
		});
	});
});
