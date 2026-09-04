<?php
// ClawPilot managed email search presentation v1.
if (!defined('sugarEntry') || !sugarEntry) {
    die('Not A Valid Entry Point');
}

require_once 'custom/include/ClawPilot/EmailSearch.php';

// Keep the selected native engine, query validation, permissions and pagination.
// Only its result presentation changes, and only for Email rows.
\SuiteCRM\Search\SearchWrapper::addEngine(
    'BasicSearchEngine',
    'custom/include/ClawPilot/EmailSearch.php',
    \ClawPilot\EmailSearch\BasicEngine::class
);
\SuiteCRM\Search\SearchWrapper::addEngine(
    'ElasticSearchEngine',
    'custom/include/ClawPilot/EmailSearch.php',
    \ClawPilot\EmailSearch\ElasticEngine::class
);
require 'modules/Home/Search.php';
