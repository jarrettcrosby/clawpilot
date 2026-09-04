<?php
// ClawPilot managed email search presentation v1.
namespace ClawPilot\EmailSearch;

if (!defined('sugarEntry') || !sugarEntry) {
    die('Not A Valid Entry Point');
}

use SuiteCRM\Search\SearchQuery;
use SuiteCRM\Search\SearchResults;

/** SuiteCRM database bean strings are HTML encoded; escape again at output. */
function scalarText($value): string
{
    return is_scalar($value)
        ? html_entity_decode((string) $value, ENT_QUOTES | ENT_HTML5, 'UTF-8')
        : '';
}

/** Never read formatted name: native search replaces it with anchor markup. */
function emailRow(object $bean): array
{
    $original = is_array($bean->fetched_row ?? null) ? $bean->fetched_row : [];
    $subject = scalarText($original['name'] ?? '');
    $id = scalarText($bean->id ?? '');
    return [
        'subject' => trim($subject) !== '' ? $subject : '(No subject)',
        'from' => scalarText($bean->from_addr_name ?? ''),
        'globalId' => scalarText($bean->global_id_c ?? ''),
        'sentAt' => scalarText($bean->date_sent_received ?? ''),
        'createdAt' => scalarText($bean->date_entered ?? ''),
        // A fixed internal destination, never a URL derived from email content.
        'detailPath' => '#/emails/record/' . rawurlencode($id),
    ];
}

class ResultsView extends \SuiteCRM\Search\UI\SearchResultsView
{
    public function __construct()
    {
        parent::__construct();
        $this->setTemplateFile('custom/include/ClawPilot/search.results.tpl');
    }

    public function preDisplay(): void
    {
        parent::preDisplay();
        $beans = $this->getTemplate()->getTemplateVars('resultsAsBean') ?? [];
        $rows = [];
        foreach ($beans['Emails'] ?? [] as $bean) {
            $rows[] = emailRow($bean);
        }
        $this->getTemplate()->assign('clawpilotEmailRows', $rows);
    }
}

class ResultsController extends \SuiteCRM\Search\UI\SearchResultsController
{
    public function __construct(SearchQuery $query, SearchResults $results)
    {
        parent::__construct($query, $results);
        $this->view = new ResultsView();
    }
}

trait EmailResultsPresentation
{
    public function displayResults(SearchQuery $query, SearchResults $results): void
    {
        (new ResultsController($query, $results))->display();
    }
}

class BasicEngine extends \SuiteCRM\Search\BasicSearch\BasicSearchEngine
{
    use EmailResultsPresentation;
}

class ElasticEngine extends \SuiteCRM\Search\ElasticSearch\ElasticSearchEngine
{
    use EmailResultsPresentation;
}
