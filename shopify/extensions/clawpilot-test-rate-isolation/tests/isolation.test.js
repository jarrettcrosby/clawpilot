import assert from "node:assert/strict";
import test from "node:test";

import {
  cartDeliveryOptionsTransformRun,
  parseIsolationConfiguration,
} from "../src/cart_delivery_options_transform_run.js";

const ALLOWED_CUSTOMER_GID = "gid://shopify/Customer/1234567890";
const OTHER_CUSTOMER_GID = "gid://shopify/Customer/9876543210";
const RATE_PREFIX = "Pro Bakery Bites · ";

function configuration(overrides = {}) {
  return {
    version: 1,
    allowedCustomerGids: [ALLOWED_CUSTOMER_GID],
    rateTitlePrefixes: [RATE_PREFIX],
    ...overrides,
  };
}

function input({
  customerGid = ALLOWED_CUSTOMER_GID,
  isAuthenticated = true,
  config = configuration(),
  groups,
} = {}) {
  return {
    cart: {
      buyerIdentity: {
        isAuthenticated,
        customer: customerGid ? { id: customerGid } : null,
      },
      deliveryGroups:
        groups ??
        [
          {
            deliveryOptions: [
              {
                handle: "clawpilot-ground",
                title: "Pro Bakery Bites · UPS · Ground",
                deliveryMethodType: "SHIPPING",
              },
              {
                handle: "native-ground",
                title: "UPS Ground",
                deliveryMethodType: "SHIPPING",
              },
              {
                handle: "store-pickup",
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

test("allows exact authenticated customer GID", () => {
  assert.deepEqual(cartDeliveryOptionsTransformRun(input()), {
    operations: [],
  });
});

test("hides only ClawPilot-prefixed rates from a different customer", () => {
  const result = cartDeliveryOptionsTransformRun(
    input({ customerGid: OTHER_CUSTOMER_GID }),
  );

  assert.deepEqual(hiddenHandles(result), ["clawpilot-ground"]);
});

test("hides ClawPilot-prefixed rates from guest checkout", () => {
  const result = cartDeliveryOptionsTransformRun(
    input({ customerGid: null, isAuthenticated: false }),
  );

  assert.deepEqual(hiddenHandles(result), ["clawpilot-ground"]);
});

test("requires authentication even if a customer GID is present", () => {
  const result = cartDeliveryOptionsTransformRun(
    input({ isAuthenticated: false }),
  );

  assert.deepEqual(hiddenHandles(result), ["clawpilot-ground"]);
});

test("filters all delivery groups and deduplicates repeated handles", () => {
  const repeatedOption = {
    handle: "clawpilot-ground",
    title: "Pro Bakery Bites · UPS · Ground",
    deliveryMethodType: "SHIPPING",
  };
  const result = cartDeliveryOptionsTransformRun(
    input({
      customerGid: OTHER_CUSTOMER_GID,
      groups: [
        { deliveryOptions: [repeatedOption] },
        {
          deliveryOptions: [
            repeatedOption,
            {
              handle: "clawpilot-air",
              title: "Pro Bakery Bites · FedEx · 2Day",
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

test("does not treat a middle-of-title match as a ClawPilot rate", () => {
  const result = cartDeliveryOptionsTransformRun(
    input({
      customerGid: OTHER_CUSTOMER_GID,
      groups: [
        {
          deliveryOptions: [
            {
              handle: "merchant-rate",
              title: `Standard ${RATE_PREFIX}UPS · Ground`,
              deliveryMethodType: "SHIPPING",
            },
          ],
        },
      ],
    }),
  );

  assert.deepEqual(result, { operations: [] });
});

test("missing configuration preserves native checkout options", () => {
  const fixture = input();
  fixture.deliveryCustomization.metafield = null;
  const result = cartDeliveryOptionsTransformRun(fixture);

  assert.deepEqual(result, { operations: [] });
});

test("malformed configuration preserves native checkout options", () => {
  const result = cartDeliveryOptionsTransformRun(
    input({
      config: configuration({
        allowedCustomerGids: ["not-a-shopify-customer-gid@example.invalid"],
      }),
    }),
  );

  assert.deepEqual(result, { operations: [] });
});

test("configuration requires exact Shopify Customer GIDs", () => {
  assert.equal(
    parseIsolationConfiguration(
      configuration({
        allowedCustomerGids: ["gid://shopify/Customer/0"],
      }),
    ),
    null,
  );
  assert.equal(
    parseIsolationConfiguration(
      configuration({
        rateTitlePrefixes: [""],
      }),
    ),
    null,
  );
});
