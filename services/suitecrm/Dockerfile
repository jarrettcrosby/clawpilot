# The initial native CLI/acceptance profile is PHP 8.3.36. An unpinned minor
# tag could silently change that runtime during the cutover image build.
FROM php:8.3.36-apache-bookworm@sha256:96f820bf68a6e443521586cdd29b9efa1b990df6105b0f8c5524a49492752676

ARG SUITECRM_VERSION=8.10.1
ARG SUITECRM_SHA256=b72da32ca7702452537cdd11e1157bc41a283accdadca66ef88f42684a571ef7

# Keep extension compilation bounded on local and hosted builders; CPU-count
# fan-out can exhaust memory and grow swap before the image is available.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl default-mysql-client git libcurl4-openssl-dev libfreetype6-dev \
    libicu-dev libjpeg62-turbo-dev libkrb5-dev libldap2-dev libonig-dev libpng-dev \
    libxml2-dev libzip-dev openssl python3 supervisor unzip \
  && python3 -B -c 'import json, os, re, signal, sys, threading; from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer' \
  && docker-php-ext-configure gd --with-freetype --with-jpeg \
  && docker-php-ext-configure ldap --with-libdir=lib/x86_64-linux-gnu \
  && docker-php-ext-install -j2 bcmath curl exif gd intl ldap mbstring mysqli opcache pdo_mysql soap zip \
  && rm -f /etc/apache2/mods-enabled/mpm_event.load /etc/apache2/mods-enabled/mpm_worker.load

RUN a2enmod mpm_prefork rewrite headers expires remoteip \
  && curl -fL --retry 4 \
    -o /tmp/suitecrm.zip \
    "https://github.com/SuiteCRM/SuiteCRM-Core/releases/download/v${SUITECRM_VERSION}/SuiteCRM-${SUITECRM_VERSION}.zip" \
  && echo "${SUITECRM_SHA256}  /tmp/suitecrm.zip" | sha256sum -c - \
  && mkdir -p /opt/suitecrm \
  && unzip -q /tmp/suitecrm.zip -d /opt/suitecrm \
  && rm -f /tmp/suitecrm.zip \
  && apt-get purge -y --auto-remove git unzip \
  && rm -rf /var/lib/apt/lists/*

# Enrolled startup checks exact root ownership and modes. Do not inherit
# group-write from the source archive or the builder's checkout umask.
COPY --chown=0:0 --chmod=0644 apache-site.conf /etc/apache2/sites-available/000-default.conf
COPY --chown=0:0 --chmod=0644 apache-ports.conf /etc/apache2/ports.conf
COPY suitecrm.ini /usr/local/etc/php/conf.d/99-suitecrm.ini
COPY supervisord.conf /etc/supervisor/conf.d/suitecrm.conf
COPY entrypoint.sh scheduler-loop.sh messenger-loop.sh /usr/local/bin/
COPY bootstrap-client.php /opt/clawpilot/bootstrap-client.php
COPY bootstrap-global-id.php /opt/clawpilot/bootstrap-global-id.php
COPY install-email-search.php /opt/clawpilot/install-email-search.php
COPY email-search /opt/clawpilot/email-search
COPY install-email-audience.php /opt/clawpilot/install-email-audience.php
COPY email-audience /opt/clawpilot/email-audience
COPY install-native-email-scope.php install-native-email-runtime.php native-email-startup-check.php /opt/clawpilot/
COPY install-native-email-initial-state.php native-email-initial-cli.php native-email-initial-install-profile.json /opt/clawpilot/
COPY native-email-initial-artifacts.php native-email-enrolled-startup.php /opt/clawpilot/
COPY native-email-recovery-cli.php /opt/clawpilot/native-email-recovery-cli.php
COPY native-email-maintenance.py native-email-liveness.json /opt/clawpilot/
COPY native-email-scope /opt/clawpilot/native-email-scope
COPY install-record-lifecycle.php /opt/clawpilot/install-record-lifecycle.php
COPY record-lifecycle /opt/clawpilot/record-lifecycle
COPY bootstrap-image-principals.php /opt/clawpilot/bootstrap-image-principals.php

RUN chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/scheduler-loop.sh /usr/local/bin/messenger-loop.sh \
  && chmod 0644 /opt/clawpilot/email-audience/NativeEmailRecoveryReadyProof.php \
  && mkdir -p /var/lib/suitecrm /var/log/supervisor \
  && chown -R www-data:www-data /var/lib/suitecrm

ENV SUITECRM_VERSION=${SUITECRM_VERSION}
WORKDIR /var/lib/suitecrm/app
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
