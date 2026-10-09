import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { resolveApprovedProductionHarness } from "../../apps/controller/src/composition/production-harness.ts";
import {
  currentComputeAbortSignal,
  withComputeAbortSignal,
} from "../../apps/controller/src/drivers/compute/runtime/operation-context.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInWithEmailPassword,
} from "../helpers/auth-session.mjs";

const installationId = "ins_3033697e-6397-4cc6-9b04-8ec17af78cf1";
const allowedNamespace = "ns_00000000-0000-4000-8000-000000000001";
const deniedNamespace = "ns_00000000-0000-4000-8000-000000000002";

async function listen(context, handler) {
  const server = createServer(handler);
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

test("the singleton Namespace HTTP route enforces internal admission and exact IAM", async (t) => {
  const authFixture = await createTestAuthPrincipal({
    installationId,
    mode: "production",
    baseURL: "http://127.0.0.1",
    email: "production-security-admin@example.test",
    password: "production-security-generated-password",
  });
  const principal = authFixture.seed.principal;

  // Give the admitted Principal access to exactly one tenant, not its neighboring Namespace.
  const iam = new NativeIAMDriver({
    loadNativeIAMState: async () => ({
      identities: [principal],
      groups: [],
      memberships: [],
      roles: [
        {
          id: "role-production-namespace-reader",
          namespaceId: allowedNamespace,
          permissions: [{ action: "read", resourceKind: "namespace" }],
        },
      ],
      bindings: [
        {
          id: "binding-production-namespace-reader",
          namespaceId: allowedNamespace,
          subjectKind: "identity",
          subjectId: principal.id,
          roleId: "role-production-namespace-reader",
        },
      ],
      restrictions: [],
    }),
  });
  const auditSink = new InMemoryAuditSink();
  const controller = new OpenClawController(
    {
      id: installationId,
      name: "Production authorization integration",
      createdAt: "2026-08-19T00:00:00.000Z",
    },
    { state: new InMemoryPlatformState({ auditSink }) },
  );
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  // Persist both real tenants so authorization is enforced by OCC, not a test-only route filter.
  await controller.transact(async (state) => {
    for (const [id, name] of [
      [allowedNamespace, "Allowed tenant"],
      [deniedNamespace, "Denied tenant"],
    ]) {
      await state.namespaces.createNamespace({
        id,
        name,
        status: "ready",
        createdAt: "2026-08-19T00:00:00.000Z",
      });
    }
  });

  // Exercise the actual registered Fastify route and production admission pipeline over HTTP.
  const app = createFastifyApp({
    controller,
    iamDriver: iam,
    resolveHarness: resolveApprovedProductionHarness,
    auditSink,
    development: {
      enabled: false,
      installationId,
    },
    auth: authFixture.auth,
  });
  t.after(async () => app.close());
  const endpoint = await app.listen({ port: 0, host: "127.0.0.1" });

  await assert.rejects(
    signInWithEmailPassword({
      origin: endpoint,
      email: authFixture.email,
      password: "wrong-production-security-password",
    }),
    /HTTP 401/,
  );
  const session = await signInWithEmailPassword({
    origin: endpoint,
    email: authFixture.email,
    password: authFixture.password,
  });

  // Missing sessions and legacy bearer credentials must fail closed.
  for (const headers of [
    {},
    { authorization: "Bearer wrong" },
    { authorization: "Basic no-longer-supported" },
  ]) {
    const response = await fetch(`${endpoint}/namespaces/${allowedNamespace}`, {
      headers,
    });
    assert.equal(response.status, 401);
  }

  // Authentication does not grant the Principal access to a neighboring Namespace.
  const forbidden = await fetch(`${endpoint}/namespaces/${deniedNamespace}`, {
    headers: authenticatedHeaders(session),
  });
  assert.equal(forbidden.status, 403);

  // Even an otherwise valid internal request must not trust forwarded client identity.
  const forwarded = await fetch(`${endpoint}/namespaces/${allowedNamespace}`, {
    headers: authenticatedHeaders(session, { "x-forwarded-for": "127.0.0.1" }),
  });
  assert.equal(forwarded.status, 403);

  // The authorized request reaches the real controller and returns its exact Namespace.
  const allowed = await fetch(`${endpoint}/namespaces/${allowedNamespace}`, {
    headers: authenticatedHeaders(session),
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual((await allowed.json()).data, {
    id: allowedNamespace,
    name: "Allowed tenant",
    status: "ready",
    createdAt: "2026-08-19T00:00:00.000Z",
  });
});

test("compute operation cancellation disconnects an actual in-flight HTTP request", async (t) => {
  // Hold a real server request open so cancelling its operation is observable as a disconnect.
  let received;
  const requestReceived = new Promise((resolve) => {
    received = resolve;
  });
  let disconnected;
  const requestDisconnected = new Promise((resolve) => {
    disconnected = resolve;
  });
  const endpoint = await listen(t, (request) => {
    request.once("close", disconnected);
    received();
  });
  const cancellation = new AbortController();

  // This proves operation-context transport cancellation; it does not simulate a database lease.
  const operation = withComputeAbortSignal(cancellation.signal, async () =>
    fetch(`${endpoint}/pending`, { signal: currentComputeAbortSignal() }),
  );
  await requestReceived;
  cancellation.abort(new Error("The compute operation was cancelled."));

  await assert.rejects(operation, /operation was cancelled/i);
  await requestDisconnected;
});
