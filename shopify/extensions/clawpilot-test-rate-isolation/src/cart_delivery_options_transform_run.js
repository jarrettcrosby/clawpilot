const CUSTOMER_GID = /^gid:\/\/shopify\/Customer\/[1-9]\d*$/u;
const MAX_COHORT_SIZE = 50;
const MAX_TITLE_PREFIXES = 10;
const MAX_TITLE_PREFIX_LENGTH = 160;

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
 * Strictly validates the app-owned configuration. Returning null preserves
 * native checkout options; provider readiness must then remain fail-closed.
 *
 * @param {unknown} value
 * @returns {{
 *   allowedCustomerGids: Set<string>,
 *   rateTitlePrefixes: string[],
 * } | null}
 */
export function parseIsolationConfiguration(value) {
  if (!isPlainObject(value) || value.version !== 1) {
    return null;
  }

  const customerGids = value.allowedCustomerGids;
  const titlePrefixes = value.rateTitlePrefixes;

  if (
    !Array.isArray(customerGids) ||
    customerGids.length < 1 ||
    customerGids.length > MAX_COHORT_SIZE ||
    customerGids.some(
      (customerGid) =>
        typeof customerGid !== "string" || !CUSTOMER_GID.test(customerGid),
    )
  ) {
    return null;
  }

  if (
    !Array.isArray(titlePrefixes) ||
    titlePrefixes.length < 1 ||
    titlePrefixes.length > MAX_TITLE_PREFIXES ||
    titlePrefixes.some(
      (prefix) =>
        typeof prefix !== "string" ||
        prefix.trim().length === 0 ||
        prefix.length > MAX_TITLE_PREFIX_LENGTH ||
        /[\u0000-\u001f\u007f]/u.test(prefix),
    )
  ) {
    return null;
  }

  return {
    allowedCustomerGids: new Set(uniqueStrings(customerGids)),
    rateTitlePrefixes: uniqueStrings(titlePrefixes),
  };
}

/**
 * @param {unknown} input
 * @returns {Array<{handle: string, title: string | null, deliveryMethodType: string}>}
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
    return NO_CHANGES;
  }

  const buyerIdentity = input?.cart?.buyerIdentity;
  const customerGid = buyerIdentity?.customer?.id;
  const isAllowedCustomer =
    buyerIdentity?.isAuthenticated === true &&
    typeof customerGid === "string" &&
    configuration.allowedCustomerGids.has(customerGid);

  if (isAllowedCustomer) {
    return NO_CHANGES;
  }

  return hideOptions(
    options,
    (option) =>
      option.deliveryMethodType === "SHIPPING" &&
      typeof option.title === "string" &&
      configuration.rateTitlePrefixes.some((prefix) =>
        option.title.startsWith(prefix),
      ),
  );
}
