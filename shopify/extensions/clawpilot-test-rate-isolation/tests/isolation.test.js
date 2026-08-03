import assert from "node:assert/strict";
import test from "node:test";

import {
  cartDeliveryOptionsTransformRun,
  parseCustomerRatePolicy,
  parseIsolationConfiguration,
} from "../src/cart_delivery_options_transform_run.js";

const CUSTOMER_GID = "gid://shopify/Customer/1234567890";
const UPS_GROUND = "clawpilot:ups_rest:03";
const FEDEX_GROUND = "clawpilot:fedex_rest:fedex_ground";

function configuration(defaultPolicy = "hide_all") {
  return {
    version: 2,
    defaultPolicy,
  };
}

function policy(mode, serviceCodes = []) {
  return {
    version: 1,
    mode,
    serviceCodes,
  };
}

function input({
  customerGid = CUSTOMER_GID,
  customerPolicy = policy("show_all"),
  isAuthenticated = true,
  config = configuration(),
  groups,
} = {}) {
  return {
    cart: {
      buyerIdentity: {
        isAuthenticated,
        customer: customerGid
          ? {
              id: customerGid,
              clawpilotRatePolicy: customerPolicy
                ? { jsonValue: customerPolicy }
                : null,
            }
          : null,
      },
      deliveryGroups:
        groups ??
        [
          {
            deliveryOptions: [
              {
                handle: "clawpilot-ground",
                code: UPS_GROUND,
                title: "Pro Bakery Bites · UPS · Ground",
                deliveryMethodType: "SHIPPING",
              },
              {
                handle: "native-ground",
                code: "shopify:ups:ground",
                title: "UPS Ground",
                deliveryMethodType: "SHIPPING",
              },
              {
                handle: "store-pickup",
                code: null,
                title: "Store pickup",
                deliveryMethodType: "PICK_UP",
              },
            ],
          },
        ],
    },
    deliveryCustomization: {
      metafield: {
        jsonValue: config,
      },
    },
  };
}

function hiddenHandles(result) {
  return result.operations.map(
    (operation) => operation.deliveryOptionHide.deliveryOptionHandle,
  );
}

test("Shadow default hides rates unless the customer policy allows them", () => {
  assert.deepEqual(cartDeliveryOptionsTransformRun(input()), {
    operations: [],
  });
  assert.deepEqual(
    hiddenHandles(cartDeliveryOptionsTransformRun(input({ customerPolicy: null }))),
    ["clawpilot-ground"],
  );
});

test("Active default shows rates to authenticated customers and guests", () => {
  const activeConfig = configuration("show_all");
  for (const fixture of [
    input({ config: activeConfig, customerPolicy: null }),
    input({
      config: activeConfig,
      customerGid: null,
      customerPolicy: null,
      isAuthenticated: false,
    }),
  ]) {
    assert.deepEqual(cartDeliveryOptionsTransformRun(fixture), {
      operations: [],
    });
  }
});

test("customer policy can include only selected ClawPilot service codes", () => {
  const result = cartDeliveryOptionsTransformRun(
    input({
      config: configuration("show_all"),
      customerPolicy: policy("include_only", [UPS_GROUND]),
      groups: [
        {
          deliveryOptions: [
            {
              handle: "clawpilot-ups-ground",
              code: UPS_GROUND,
              title: "Store · UPS · Ground",
              deliveryMethodType: "SHIPPING",
            },
            {
              handle: "clawpilot-fedex-ground",
              code: FEDEX_GROUND,
              title: "Store · FedEx · Ground",
              deliveryMethodType: "SHIPPING",
            },
          ],
        },
      ],
    }),
  );

  assert.deepEqual(hiddenHandles(result), ["clawpilot-fedex-ground"]);
});

test("customer policy can exclude selected ClawPilot service codes", () => {
  const result = cartDeliveryOptionsTransformRun(
    input({
      config: configuration("show_all"),
      customerPolicy: policy("exclude", [UPS_GROUND]),
    }),
  );

  assert.deepEqual(hiddenHandles(result), ["clawpilot-ground"]);
});

test("an unauthenticated cart never inherits a supplied customer policy", () => {
  const result = cartDeliveryOptionsTransformRun(
    input({ isAuthenticated: false }),
  );

  assert.deepEqual(hiddenHandles(result), ["clawpilot-ground"]);
});

test("filters all delivery groups and deduplicates repeated handles", () => {
  const repeatedOption = {
    handle: "clawpilot-ground",
    code: UPS_GROUND,
    title: "Any mutable store title",
    deliveryMethodType: "SHIPPING",
  };
  const result = cartDeliveryOptionsTransformRun(
    input({
      customerPolicy: policy("hide_all"),
      groups: [
        { deliveryOptions: [repeatedOption] },
        {
          deliveryOptions: [
            repeatedOption,
            {
              handle: "clawpilot-air",
              code: FEDEX_GROUND,
              title: "A different mutable title",
              deliveryMethodType: "SHIPPING",
            },
          ],
        },
      ],
    }),
  );

  assert.deepEqual(hiddenHandles(result), [
    "clawpilot-ground",
    "clawpilot-air",
  ]);
});

test("identifies ClawPilot options by stable service code, not display title", () => {
  const result = cartDeliveryOptionsTransformRun(
    input({
      customerPolicy: policy("hide_all"),
      groups: [
        {
          deliveryOptions: [
            {
              handle: "clawpilot-renamed",
              code: UPS_GROUND,
              title: "A completely renamed rate",
              deliveryMethodType: "SHIPPING",
            },
            {
              handle: "merchant-similar-title",
              code: "merchant:ground",
              title: "Pro Bakery Bites · UPS · Ground",
              deliveryMethodType: "SHIPPING",
            },
          ],
        },
      ],
    }),
  );

  assert.deepEqual(hiddenHandles(result), ["clawpilot-renamed"]);
});

test("missing or malformed global configuration fails closed for ClawPilot rates", () => {
  const missing = input();
  missing.deliveryCustomization.metafield = null;
  assert.deepEqual(hiddenHandles(cartDeliveryOptionsTransformRun(missing)), [
    "clawpilot-ground",
  ]);

  assert.deepEqual(
    hiddenHandles(
      cartDeliveryOptionsTransformRun(
        input({ config: { version: 2, defaultPolicy: "unknown" } }),
      ),
    ),
    ["clawpilot-ground"],
  );
});

test("malformed customer policy falls back to the configured default", () => {
  const result = cartDeliveryOptionsTransformRun(
    input({
      customerPolicy: policy("include_only", ["not-a-clawpilot-code"]),
    }),
  );

  assert.deepEqual(hiddenHandles(result), ["clawpilot-ground"]);
});

test("five concurrent entry paths for one authenticated customer are deterministic", async () => {
  const fixtures = Array.from({ length: 5 }, (_, index) =>
    input({
      groups: [
        {
          deliveryOptions: [
            {
              handle: `clawpilot-ground-${index}`,
              code: UPS_GROUND,
              title: `Device ${index + 1} display title`,
              deliveryMethodType: "SHIPPING",
            },
          ],
        },
      ],
    }),
  );

  const results = await Promise.all(
    fixtures.map(async (fixture) => cartDeliveryOptionsTransformRun(fixture)),
  );
  assert.deepEqual(results, Array.from({ length: 5 }, () => ({ operations: [] })));
});

test("customer policies are strict and have no central customer-count limit", () => {
  assert.deepEqual(parseIsolationConfiguration(configuration("show_all")), {
    defaultPolicy: "show_all",
  });
  assert.equal(
    parseIsolationConfiguration({ version: 2, defaultPolicy: "unknown" }),
    null,
  );
  assert.equal(
    parseCustomerRatePolicy(policy("include_only", [])),
    null,
  );
  assert.equal(
    parseCustomerRatePolicy(policy("show_all", [UPS_GROUND])),
    null,
  );
});
