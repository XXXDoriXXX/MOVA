import { killPort } from '@nx/node/utils';
/* eslint-disable */

module.exports = async function () {
  // The Nx scaffold assumed the test BOOTS its own dev server (via
  // `nx serve api-gateway` in the background) and so kills the port
  // afterward. Our e2e suite hits a SHARED docker-compose stack —
  // killing port 3000 here yanks the live api-gateway out from under
  // anyone else running locally (and we saw it take Docker Desktop's
  // engine pipe with it on Windows). Opt out via E2E_BASE_URL: when
  // set, the operator owns the lifecycle of the target server.
  if (!process.env['E2E_BASE_URL']) {
    const port = process.env.PORT ? Number(process.env.PORT) : 3000;
    await killPort(port);
  }
  console.log(globalThis.__TEARDOWN_MESSAGE__);
};
