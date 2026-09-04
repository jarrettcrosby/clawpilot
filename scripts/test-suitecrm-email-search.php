<?php
declare(strict_types=1);

/**
 * Database-free behavioral tests for the real ClawPilot Email search extension.
 * Requires actual Smarty 4.5.6: CLAWPILOT_TEST_SMARTY_ROOT=/path/to/smarty.
 * Native framework boundaries below are deliberately small stubs; the installer,
 * custom PHP classes, wrapper actions and Smarty template are production files.
 * No SuiteCRM bootstrap, credentials, database or provider connection is loaded.
 */
namespace {
    $smartyRoot = getenv('CLAWPILOT_TEST_SMARTY_ROOT') ?: '';
    $smartyClass = $smartyRoot . '/libs/Smarty.class.php';
    if (!is_file($smartyClass)) {
        fwrite(STDERR, "Set CLAWPILOT_TEST_SMARTY_ROOT to the pinned Smarty 4.5.6 directory.\n");
        exit(1);
    }
    require_once $smartyClass;
    if (Smarty::SMARTY_VERSION !== '4.5.6') {
        throw new RuntimeException('Expected actual Smarty 4.5.6');
    }
    define('sugarEntry', true);

    class Sugar_Smarty extends \Smarty
    {
        public function __construct()
        {
            parent::__construct();
            $this->setCompileDir($GLOBALS['clawpilotTestCompileDir']);
            $this->setTemplateDir(getcwd());
            $this->auto_literal = false;
            $this->force_compile = true;
        }
    }
}

namespace SuiteCRM\Search {
    class SearchQuery
    {
        public array $trace = [];
    }

    class SearchResults
    {
        public function __construct(public array $beans, public array $pagination = []) {}
        public function getModuleTotal($module): int { return count($this->beans[$module] ?? []); }
        public function getSearchTime(): float { return 0.001; }
    }

    class SearchWrapper
    {
        public static array $engines = [];
        public static function addEngine(string $name, string $path, string $class): void
        {
            self::$engines[$name] = ['path' => $path, 'class' => $class];
        }
    }

    abstract class NativeEngineFixture
    {
        public function validateQuery(SearchQuery $query): void { $query->trace[] = 'validate'; }
        public function displayForm(SearchQuery $query): void { $query->trace[] = 'form'; }
        public function search(SearchQuery $query): SearchResults
        {
            $query->trace[] = 'search';
            return new SearchResults($GLOBALS['clawpilotTestEngineBeans']);
        }
        public function searchAndDisplay(SearchQuery $query): void
        {
            $this->validateQuery($query);
            $this->displayForm($query);
            $this->displayResults($query, $this->search($query));
        }
        public function displayResults(SearchQuery $query, SearchResults $results): void
        {
            throw new \RuntimeException('Native result renderer should have been overridden');
        }
    }
}

namespace SuiteCRM\Search\BasicSearch {
    class BasicSearchEngine extends \SuiteCRM\Search\NativeEngineFixture {}
}

namespace SuiteCRM\Search\ElasticSearch {
    class ElasticSearchEngine extends \SuiteCRM\Search\NativeEngineFixture {}
}

namespace SuiteCRM\Search\UI {
    class SearchResultsView
    {
        protected \Sugar_Smarty $smarty;
        protected string $templateFile = '/native/absolute/search.results.tpl';
        public function __construct() { $this->smarty = new \Sugar_Smarty(); }
        public function setTemplateFile(string $file): void { $this->templateFile = $file; }
        public function getTemplateFile(): string { return $this->templateFile; }
        public function getTemplate(): \Sugar_Smarty { return $this->smarty; }
        public function preDisplay(): void {}
        public function display(): void { $this->smarty->display($this->templateFile); }
    }

    class SearchResultsController
    {
        protected SearchResultsView $view;
        public function __construct(
            protected \SuiteCRM\Search\SearchQuery $query,
            protected \SuiteCRM\Search\SearchResults $results
        ) { $this->view = new SearchResultsView(); }

        public function display(): void
        {
            $this->query->trace[] = 'results';
            $headers = [];
            $labels = [];
            $total = 0;
            foreach ($this->results->beans as $module => $beans) {
                $labels[$module] = $module;
                $headers[$module] = [['field' => 'name', 'label' => 'Name', 'comment' => 'Native name']];
                $total += count($beans);
            }
            $this->view->getTemplate()->assign([
                'APP' => [
                    'LBL_SEARCH_RESULTS_TITLE' => 'Search Results', 'LBL_SEARCH_TOTAL' => 'Total: ',
                    'ERR_SEARCH_INVALID_QUERY' => 'Invalid search', 'ERR_SEARCH_NO_RESULTS' => 'No results',
                    'LBL_SEARCH_PREV' => 'Previous', 'LBL_SEARCH_NEXT' => 'Next',
                    'LBL_SEARCH_PAGE' => 'Page ', 'LBL_SEARCH_OF' => ' of ',
                    'LBL_SEARCH_PERFORMED_IN' => 'Search completed in',
                ],
                'SITE_URL' => 'https://crm.example.test', 'error' => false,
                'total' => $total, 'results' => $this->results,
                'resultsAsBean' => $this->results->beans, 'moduleLabel' => $labels,
                'headers' => $headers, 'pagination' => $this->results->pagination ?: false,
            ]);
            $this->view->preDisplay();
            $this->view->display();
        }
    }
}

namespace {
    $repoRoot = dirname(__DIR__);
    $sourceRoot = $repoRoot . '/services/suitecrm/email-search';
    require_once $repoRoot . '/services/suitecrm/install-email-search.php';

    $taskRoot = sys_get_temp_dir() . '/clawpilot-email-search-test-' . bin2hex(random_bytes(8));
    if (!mkdir($taskRoot, 0700)) {
        throw new RuntimeException('Cannot create isolated test root');
    }
    $GLOBALS['clawpilotTestCompileDir'] = $taskRoot . '/compile';
    mkdir($GLOBALS['clawpilotTestCompileDir'], 0700);
    $originalCwd = getcwd();
    $cases = 0;
    $failures = [];
    $targets = [
        'Search.php' => 'custom/modules/Home/Search.php',
        'UnifiedSearch.php' => 'custom/modules/Home/UnifiedSearch.php',
        'EmailSearch.php' => 'custom/include/ClawPilot/EmailSearch.php',
        'search.results.tpl' => 'custom/include/ClawPilot/search.results.tpl',
    ];

    function check(bool $condition, string $message): void
    {
        if (!$condition) { throw new RuntimeException($message); }
    }
    function same($actual, $expected, string $message): void { check($actual === $expected, $message); }
    function scenario(string $name, callable $callback): void
    {
        global $cases, $failures;
        $cases++;
        try { $callback(); echo "PASS {$name}\n"; }
        catch (\Throwable $error) { $failures[] = $name; fwrite(STDERR, "FAIL {$name}: {$error->getMessage()}\n"); }
    }
    function fixtureDirectory(string $name): string
    {
        $path = $GLOBALS['taskRoot'] . '/' . $name;
        if (!mkdir($path, 0700, true)) { throw new RuntimeException('Fixture directory failed'); }
        return $path;
    }
    function putFixture(string $path, string $contents): void
    {
        if (!is_dir(dirname($path))) { mkdir(dirname($path), 0700, true); }
        if (file_put_contents($path, $contents) !== strlen($contents)) { throw new RuntimeException('Fixture write failed'); }
    }
    function expectInstallerRejection(string $sources, string $destination, string $message): void
    {
        $rejected = false;
        try { install_clawpilot_email_search($sources, $destination); }
        catch (\RuntimeException $error) { $rejected = true; }
        check($rejected, $message);
    }
    function renderResults(array $beans, array $pagination = []): string
    {
        $controller = new \ClawPilot\EmailSearch\ResultsController(
            new \SuiteCRM\Search\SearchQuery(), new \SuiteCRM\Search\SearchResults($beans, $pagination)
        );
        ob_start();
        try { $controller->display(); return ob_get_contents(); }
        finally { ob_end_clean(); }
    }
    function emailFixture(array $changes = []): object
    {
        return (object) array_replace([
            'id' => '77072e00-1111-4222-8333-444444444444',
            'name' => '<a href="javascript:wrong">WRONG FORMATTED SUBJECT</a>',
            'fetched_row' => ['name' => 'Retained &amp; readable subject'],
            'from_addr_name' => 'Sender &lt;sender@example.test&gt;',
            'global_id_c' => 'giemgr141utrl0',
            'date_sent_received' => '2026-09-04 09:00', 'date_entered' => '2026-09-04 09:01',
        ], $changes);
    }
    function removeTestTree(string $path): void
    {
        if (is_link($path) || is_file($path)) { unlink($path); return; }
        foreach (new \FilesystemIterator($path) as $entry) { removeTestTree($entry->getPathname()); }
        rmdir($path);
    }

    try {
        $legacyRoot = fixtureDirectory('legacy');
        scenario('installer writes only the four managed files', function () use ($sourceRoot, $legacyRoot, $targets) {
            putFixture($legacyRoot . '/modules/Emails/metadata/listviewdefs.php', 'native-layout-preserved');
            putFixture($legacyRoot . '/custom/modules/Emails/metadata/listviewdefs.php', 'operator-layout-preserved');
            install_clawpilot_email_search($sourceRoot, $legacyRoot);
            foreach ($targets as $source => $target) {
                same(file_get_contents($legacyRoot . '/' . $target), file_get_contents($sourceRoot . '/' . $source), 'Installed bytes differ');
                same(fileperms($legacyRoot . '/' . $target) & 0777, 0644, 'Unexpected managed mode');
            }
            same(file_get_contents($legacyRoot . '/modules/Emails/metadata/listviewdefs.php'), 'native-layout-preserved', 'Native Email layout changed');
            same(file_get_contents($legacyRoot . '/custom/modules/Emails/metadata/listviewdefs.php'), 'operator-layout-preserved', 'Operator Email layout changed');
        });
        scenario('identical installer rerun is a physical no-op', function () use ($sourceRoot, $legacyRoot, $targets) {
            $before = [];
            foreach ($targets as $target) { $before[$target] = stat($legacyRoot . '/' . $target); }
            install_clawpilot_email_search($sourceRoot, $legacyRoot);
            clearstatcache();
            foreach ($targets as $target) { same(stat($legacyRoot . '/' . $target), $before[$target], 'Idempotent install rewrote a file'); }
        });
        scenario('unmanaged late target rejects before any managed write', function () use ($sourceRoot) {
            $root = fixtureDirectory('unmanaged');
            $path = $root . '/custom/modules/Home/UnifiedSearch.php';
            putFixture($path, '<?php // operator action');
            expectInstallerRejection($sourceRoot, $root, 'Unmanaged content was accepted');
            same(file_get_contents($path), '<?php // operator action', 'Unmanaged content changed');
            check(!file_exists($root . '/custom/modules/Home/Search.php'), 'Preflight wrote an earlier target');
            check(!file_exists($root . '/custom/include/ClawPilot/EmailSearch.php'), 'Preflight wrote a dependency before detecting the conflict');
        });
        scenario('dependency installation failure never publishes a new Home action', function () use ($sourceRoot) {
            $root = fixtureDirectory('blocked-dependency');
            putFixture($root . '/custom/include/ClawPilot', 'blocking-file-preserved');
            set_error_handler(static function (int $severity, string $message): never {
                throw new \RuntimeException('Expected dependency filesystem rejection');
            });
            try { expectInstallerRejection($sourceRoot, $root, 'Blocked dependency was accepted'); }
            finally { restore_error_handler(); }
            same(file_get_contents($root . '/custom/include/ClawPilot'), 'blocking-file-preserved', 'Blocking file was altered');
            check(!file_exists($root . '/custom/modules/Home/Search.php'), 'Search action was published before its dependencies');
            check(!file_exists($root . '/custom/modules/Home/UnifiedSearch.php'), 'UnifiedSearch action was published before its dependencies');
        });
        scenario('missing ownership marker rejects before writes', function () use ($sourceRoot, $targets) {
            $sources = fixtureDirectory('invalid-source');
            foreach ($targets as $source => $_) { copy($sourceRoot . '/' . $source, $sources . '/' . $source); }
            putFixture($sources . '/search.results.tpl', 'unmanaged template');
            $root = fixtureDirectory('invalid-source-output');
            expectInstallerRejection($sources, $root, 'Unmarked source was accepted');
            check(!file_exists($root . '/custom'), 'Invalid source caused a partial install');
        });
        scenario('target symlink is rejected without touching its destination', function () use ($sourceRoot) {
            $root = fixtureDirectory('target-symlink');
            $outside = $GLOBALS['taskRoot'] . '/target-outside.txt';
            putFixture($outside, 'outside-preserved');
            mkdir($root . '/custom/include/ClawPilot', 0700, true);
            symlink($outside, $root . '/custom/include/ClawPilot/EmailSearch.php');
            expectInstallerRejection($sourceRoot, $root, 'Symlink target was accepted');
            same(file_get_contents($outside), 'outside-preserved', 'Symlink destination changed');
            check(!file_exists($root . '/custom/modules/Home/Search.php'), 'Symlink rejection happened after a write');
        });
        scenario('parent symlink is rejected before writing outside the legacy root', function () use ($sourceRoot) {
            $root = fixtureDirectory('parent-symlink');
            $outside = fixtureDirectory('parent-outside');
            mkdir($root . '/custom/modules', 0700, true);
            symlink($outside, $root . '/custom/modules/Home');
            expectInstallerRejection($sourceRoot, $root, 'Symlink parent was accepted');
            same(iterator_count(new \FilesystemIterator($outside)), 0, 'Installer escaped through a parent symlink');
        });
        scenario('managed update changes only the modified owned asset', function () use ($sourceRoot, $targets) {
            $root = fixtureDirectory('managed-update');
            $sources = fixtureDirectory('managed-update-source');
            foreach ($targets as $source => $_) { copy($sourceRoot . '/' . $source, $sources . '/' . $source); }
            install_clawpilot_email_search($sources, $root);
            $unchangedInode = fileinode($root . '/custom/modules/Home/Search.php');
            $updated = file_get_contents($sources . '/EmailSearch.php') . "\n// Managed test revision.\n";
            putFixture($sources . '/EmailSearch.php', $updated);
            install_clawpilot_email_search($sources, $root);
            same(file_get_contents($root . '/custom/include/ClawPilot/EmailSearch.php'), $updated, 'Owned update not applied');
            clearstatcache();
            same(fileinode($root . '/custom/modules/Home/Search.php'), $unchangedInode, 'Unchanged owned asset was rewritten');
        });

        chdir($legacyRoot);
        require_once $legacyRoot . '/custom/include/ClawPilot/EmailSearch.php';
        scenario('real Smarty renders Email scalars and its exact SuiteCRM record link', function () {
            $html = renderResults(['Emails' => [emailFixture()]]);
            foreach (['Subject', 'From', 'Global ID', 'giemgr141utrl0', 'Retained &amp; readable subject', 'Sender &lt;sender@example.test&gt;'] as $value) {
                check(str_contains($html, $value), 'Expected Email content missing');
            }
            check(str_contains($html, 'href="https://crm.example.test/#/emails/record/77072e00-1111-4222-8333-444444444444"'), 'Incorrect SuiteCRM detail destination');
            check(str_contains($html, 'target="_top"'), 'Detail link remains trapped in the legacy iframe');
            check(!str_contains($html, 'EditView'), 'Email search still exposes the edit-only action');
            check(!str_contains($html, 'WRONG FORMATTED SUBJECT'), 'Formatted bean name leaked into output');
            same(substr_count($html, '<a '), 1, 'Expected exactly one Email link');
        });
        scenario('hostile-looking Email text remains literal and single-escaped', function () {
            $bean = emailFixture([
                'fetched_row' => ['name' => '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot;'],
                'from_addr_name' => '&lt;script&gt;alert(2)&lt;/script&gt;',
                'global_id_c' => '&lt;svg onload=alert(3)&gt;',
                'date_sent_received' => '&lt;img src=x&gt;',
            ]);
            $html = renderResults(['Emails' => [$bean]]);
            check(str_contains($html, '&lt;img src=x onerror=alert(1)&gt;'), 'Subject markup was dropped or not escaped');
            check(str_contains($html, '&lt;script&gt;alert(2)&lt;/script&gt;'), 'Sender markup was not escaped');
            check(str_contains($html, '&lt;svg onload=alert(3)&gt;'), 'Global ID markup was not escaped');
            check(!preg_match('/<(?:img|script|svg)\b/i', $html), 'Email text created an executable element');
            check(!str_contains($html, '&amp;lt;'), 'DB-encoded Email value was double-escaped');
        });
        scenario('record ID is encoded and cannot change the fixed internal action', function () {
            $html = renderResults(['Emails' => [emailFixture(['id' => 'id&action=Delete"<x>'])]]);
            check(str_contains($html, '/#/emails/record/id%26action%3DDelete%22%3Cx%3E'), 'Record ID was not encoded');
            same(substr_count($html, '/#/emails/record/'), 1, 'Fixed read route changed');
            check(!str_contains($html, '&action=Delete'), 'Record value injected an action');
        });
        scenario('missing or nonscalar fields do not fabricate a subject or sender', function () {
            $bean = emailFixture(['fetched_row' => ['name' => []], 'from_addr_name' => [], 'global_id_c' => null]);
            $html = renderResults(['Emails' => [$bean]]);
            check(str_contains($html, '(No subject)'), 'Missing subject fallback absent');
            check(str_contains($html, 'Unavailable'), 'Missing From fallback absent');
            check(!str_contains($html, 'WRONG FORMATTED SUBJECT'), 'Unsafe formatted-name fallback used');
        });
        scenario('two Email results retain separate exact IDs and view preparation is read-only', function () {
            $first = emailFixture();
            $second = emailFixture(['id' => 'second-id', 'global_id_c' => 'second-global', 'fetched_row' => ['name' => 'Second subject']]);
            $before = serialize([$first, $second]);
            $html = renderResults(['Emails' => [$first, $second]]);
            same(substr_count($html, '/#/emails/record/'), 2, 'Result rows were merged or duplicated');
            check(str_contains($html, 'second-global') && str_contains($html, '/emails/record/second-id'), 'Second identity lost');
            same(serialize([$first, $second]), $before, 'Rendering mutated source beans');
        });
        scenario('non-Email markup and native pagination remain available in mixed results', function () {
            $account = (object) ['id' => 'account-id', 'name' => '<a href="native-account-link">Account name</a>'];
            $html = renderResults(['Emails' => [emailFixture()], 'Accounts' => [$account]], [
                'prev' => true, 'next' => false, 'page' => 2, 'last' => 2, 'size' => 10, 'from' => 10, 'string' => 'fixture',
            ]);
            check(str_contains($html, '<a href="native-account-link">Account name</a>'), 'Non-Email native link changed');
            check(str_contains($html, 'action=EditView&module=Accounts&record=account-id'), 'Non-Email native action changed');
            check(str_contains($html, 'Page 2 of 2') && str_contains($html, 'var from = 10;'), 'Native pagination state changed');
            same(substr_count($html, 'clawpilot-email-search'), 1, 'Email-only branch affected another module');
        });
        scenario('custom engine subclasses inherit native search, validation and form behavior', function () {
            $GLOBALS['clawpilotTestEngineBeans'] = ['Emails' => [emailFixture()]];
            foreach ([\ClawPilot\EmailSearch\BasicEngine::class, \ClawPilot\EmailSearch\ElasticEngine::class] as $class) {
                foreach (['search', 'validateQuery', 'displayForm', 'searchAndDisplay'] as $method) {
                    same((new \ReflectionMethod($class, $method))->getDeclaringClass()->getName(), \SuiteCRM\Search\NativeEngineFixture::class, 'Extension replaced a native engine method');
                }
                $query = new \SuiteCRM\Search\SearchQuery();
                ob_start();
                try { (new $class())->searchAndDisplay($query); $html = ob_get_contents(); }
                finally { ob_end_clean(); }
                same($query->trace, ['validate', 'form', 'search', 'results'], 'Native call sequence changed');
                check(str_contains($html, 'giemgr141utrl0'), 'Engine did not use the real custom result renderer');
            }
        });
        scenario('both Home wrappers delegate to the native action without changing configuration', function () use ($legacyRoot) {
            putFixture($legacyRoot . '/modules/Home/Search.php', '<?php $GLOBALS["clawpilotNativeActionCalls"]++;');
            $GLOBALS['clawpilotNativeActionCalls'] = 0;
            $GLOBALS['sugar_config'] = ['search' => ['defaultEngine' => 'ElasticSearchEngine', 'controller' => 'Search'], 'untouched' => 'sentinel'];
            $before = $GLOBALS['sugar_config'];
            require $legacyRoot . '/custom/modules/Home/Search.php';
            require $legacyRoot . '/custom/modules/Home/UnifiedSearch.php';
            same($GLOBALS['clawpilotNativeActionCalls'], 2, 'A supported action missed the native entrypoint');
            same($GLOBALS['sugar_config'], $before, 'Wrapper modified search configuration');
            same(array_keys(\SuiteCRM\Search\SearchWrapper::$engines), ['BasicSearchEngine', 'ElasticSearchEngine'], 'Wrapper registered unrelated engines');
            same(\SuiteCRM\Search\SearchWrapper::$engines['BasicSearchEngine']['class'], \ClawPilot\EmailSearch\BasicEngine::class, 'Basic engine mapping incorrect');
            same(\SuiteCRM\Search\SearchWrapper::$engines['ElasticSearchEngine']['class'], \ClawPilot\EmailSearch\ElasticEngine::class, 'Elastic engine mapping incorrect');
        });
    } finally {
        chdir($originalCwd);
        removeTestTree($taskRoot);
    }

    echo 'SuiteCRM Email search behavior: ' . ($cases - count($failures)) . '/' . $cases . " passed (actual Smarty 4.5.6; database/provider requests 0).\n";
    exit($failures ? 1 : 0);
}
