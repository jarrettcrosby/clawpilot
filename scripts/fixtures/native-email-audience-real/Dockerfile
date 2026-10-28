# Test dependency image only. Source is checksum-verified and mounted read-only
# by the acceptance runner; no application code or credentials enter this image.
ARG PHP_IMAGE=php@sha256:8dbeb51c352cf1f70d5d50f3642c9fbed311e914475ea2382f5bc1525bef7bb3
FROM ${PHP_IMAGE}

RUN apk add --no-cache \
      curl icu-libs libzip libpng libjpeg-turbo freetype libldap oniguruma libxml2 \
    && apk add --no-cache --virtual .native-build-deps \
      $PHPIZE_DEPS curl-dev icu-dev libzip-dev libpng-dev libjpeg-turbo-dev \
      freetype-dev openldap-dev oniguruma-dev libxml2-dev \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j2 bcmath curl exif gd intl ldap mbstring mysqli pdo_mysql soap zip \
    && apk del .native-build-deps \
    && php -r 'foreach (["mysqli", "pdo_mysql", "curl", "gd", "intl", "mbstring", "soap", "zip"] as $module) { if (!extension_loaded($module)) { fwrite(STDERR, "Missing test runtime module: $module\n"); exit(1); } }'

WORKDIR /app
ENTRYPOINT ["php"]
