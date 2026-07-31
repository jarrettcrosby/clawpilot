const CLAWPILOT_RATE_CODE = /^clawpilot:[a-z0-9](?:[a-z0-9_-]{0,31}):[a-z0-9](?:[a-z0-9_-]{0,31})$/u;
const MAX_SERVICE_CODES = 50;

const NO_CHANGES = Object.freeze({
  operations: [],
});

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

/**
 * Strictly validates the app-owned configuration. A null result causes every
 * positively identified ClawPilot option to be hidden.
 *
 * @param {unknown} value
 * @returns {{
 *   defaultPolicy: "show_all" | "hide_all",
 * } | null}
 */
export function parseIsolationConfiguration(value) {
  if (
    !isPlainObject(value)
    || value.version !== 2
    || !["show_all", "hide_all"].includes(value.defaultPolicy)
  ) {
    return null;
  }

  return {
    defaultPolicy: value.defaultPolicy,
  };
}

/**
 * A policy is stored on the Shopify Customer resource, so the number of
 * customers is not bounded by one Delivery Customization configuration.
 *
 * @param {unknown} value
 * @returns {{
 *   mode: "show_all" | "hide_all" | "include_only" | "exclude",
 *   serviceCodes: Set<string>,
 * } | null}
 */
export function parseCustomerRatePolicy(value) {
  if (!isPlainObject(value) || value.version !== 1) {
    return null;
  }
  const mode = value.mode;
  if (!["show_all", "hide_all", "include_only", "exclude"].includes(mode)) {
    return null;
  }
  const rawCodes = value.serviceCodes ?? [];
  if (
    !Array.isArray(rawCodes)
    || rawCodes.length > MAX_SERVICE_CODES
    || rawCodes.some(
      (code) => typeof code !== "string" || !CLAWPILOT_RATE_CODE.test(code),
    )
    || (["include_only", "exclude"].includes(mode) && rawCodes.length === 0)
    || (["show_all", "hide_all"].includes(mode) && rawCodes.length !== 0)
  ) {
    return null;
  }
  return {
    mode,
    serviceCodes: new Set(uniqueStrings(rawCodes)),
  };
}

/**
 * @param {unknown} input
 * @returns {Array<{handle: string, code: string | null, title: string | null, deliveryMethodType: string}>}
 */
function collectDeliveryOptions(input) {
  const groups = input?.cart?.deliveryGroups;

  if (!Array.isArray(groups)) {
    return [];
  }

  return groups.flatMap((group) => {
    if (!Array.isArray(group?.deliveryOptions)) {
      return [];
    }

    return group.deliveryOptions.filter(
      (option) =>
        option &&
        typeof option.handle === "string" &&
        typeof option.deliveryMethodType === "string",
    );
  });
}

function isClawPilotRate(option) {
  return (
    option.deliveryMethodType === "SHIPPING"
    && typeof option.code === "string"
    && CLAWPILOT_RATE_CODE.test(option.code)
  );
}

function hideOptions(options, predicate) {
  const handles = new Set();

  for (const option of options) {
    if (predicate(option)) {
      handles.add(option.handle);
    }
  }

  return {
    operations: [...handles].map((deliveryOptionHandle) => ({
      deliveryOptionHide: {
        deliveryOptionHandle,
      },
    })),
  };
}

/**
 * Shopify Delivery Customization Function target:
 * cart.delivery-options.transform.run
 *
 * @param {unknown} input
 * @returns {{operations: Array<{deliveryOptionHide: {deliveryOptionHandle: string}}>} }
 */
export function cartDeliveryOptionsTransformRun(input) {
  const options = collectDeliveryOptions(input);
  const rawConfiguration =
    input?.deliveryCustomization?.metafield?.jsonValue;
  const configuration = parseIsolationConfiguration(rawConfiguration);

  if (!configuration) {
    return hideOptions(options, isClawPilotRate);
  }

  const buyerIdentity = input?.cart?.buyerIdentity;
  const customerPolicy =
    buyerIdentity?.isAuthenticated === true &&
    typeof buyerIdentity?.customer?.id === "string"
      ? parseCustomerRatePolicy(
          buyerIdentity.customer.clawpilotRatePolicy?.jsonValue,
        )
      : null;

  const effectiveMode = customerPolicy?.mode ?? configuration.defaultPolicy;

  if (effectiveMode === "show_all") {
    return NO_CHANGES;
  }

  return hideOptions(
    options,
    (option) => {
      if (!isClawPilotRate(option)) return false;
      if (effectiveMode === "hide_all") return true;
      if (effectiveMode === "include_only") {
        return !customerPolicy.serviceCodes.has(option.code);
      }
      return customerPolicy.serviceCodes.has(option.code);
    },
  );
}
