<?php
declare(strict_types=1);
require_once __DIR__.'/NativeEmailAuthorityContract.php';

/** Scalar value contract only. Neither this object nor its digest proves a
 * cancelled operation, installed files, a predecessor chain or authority.
 * SQL and the native fenced reader independently establish those facts. */
final class ClawPilotNativeEmailInitialInstallationLineage
{
    private const ANCHORS=['rootOperationId','rootInstallationJournalFingerprint','rootSourceArtifactDigest','rootStockRuntimeFingerprint',
        'predecessorOperationId','predecessorPlanHash','predecessorApprovalHash','predecessorCancellationReceiptHash','cancelledHistoryFingerprint'];
    private const FRESH=['freshSourceArtifactDigest','freshInstalledRuntimeFingerprint'];
    public const HISTORY_KEYS=['operationId','planHash','deltaFingerprint','approvalHash','cancellationReceiptHash'];

    public static function prepare(mixed $value,string $currentOperationId): array
    {return self::scalar($value,$currentOperationId,false);}
    public static function prepareContext(mixed $value,string $currentOperationId): array
    {return self::scalar($value,$currentOperationId,true);}
    public static function contextFromLineage(mixed $value,string $currentOperationId): array
    {
        $context=self::prepare($value,$currentOperationId);foreach(self::FRESH as $key)unset($context[$key]);
        $context['purpose']='clawpilot-native-email-initial-replan-context';
        return self::prepareContext($context,$currentOperationId);
    }
    public static function digest(mixed $value,string $currentOperationId): string
    {return ClawPilotNativeEmailAuthorityContract::digest(self::prepare($value,$currentOperationId));}
    public static function effectiveInstallationJournalFingerprint(mixed $value,string $currentOperationId): string
    {
        $lineage=self::prepare($value,$currentOperationId);
        return ClawPilotNativeEmailAuthorityContract::digest(['version'=>1,'purpose'=>'clawpilot-native-email-initial-effective-installation',
            'rootInstallationJournalFingerprint'=>$lineage['rootInstallationJournalFingerprint'],
            'installationLineageHash'=>ClawPilotNativeEmailAuthorityContract::digest($lineage)]);
    }
    /** Exact sorted five-field inventory; physical row metadata is excluded. */
    public static function historyFingerprint(array $history): string
    {
        self::need(array_is_list($history)&&count($history)<=500,'history_bound');$previous='';
        foreach($history as $row){self::keys($row,self::HISTORY_KEYS);
            foreach(self::HISTORY_KEYS as $key)self::need(self::hash($row[$key]),'history_hash');
            self::need(strcmp($row['operationId'],$previous)>0,'history_order');$previous=$row['operationId'];}
        return ClawPilotNativeEmailAuthorityContract::digest($history);
    }
    private static function scalar(mixed $value,string $currentOperationId,bool $context): array
    {
        self::need(self::hash($currentOperationId),'operation');
        $hashes=array_merge(self::ANCHORS,$context?[]:self::FRESH);
        self::keys($value,array_merge(['version','purpose'],$hashes,['previousLineageHash','depth']));
        self::need($value['version']===1&&$value['purpose']===($context?'clawpilot-native-email-initial-replan-context'
            :'clawpilot-native-email-initial-installation-lineage'),'domain');
        foreach($hashes as $key)self::need(self::hash($value[$key]),'hash');
        self::need($value['previousLineageHash']===null||self::hash($value['previousLineageHash']),'hash');
        self::need(is_int($value['depth'])&&$value['depth']>=1&&$value['depth']<=500,'depth');
        self::need($value['rootOperationId']!==$currentOperationId&&$value['predecessorOperationId']!==$currentOperationId,'self');
        self::need($value['depth']===1
            ?$value['predecessorOperationId']===$value['rootOperationId']&&$value['previousLineageHash']===null
            :$value['predecessorOperationId']!==$value['rootOperationId']&&self::hash($value['previousLineageHash']),'predecessor');
        // PHP arrays have value semantics; canonical round-trip additionally
        // severs caller references and returns only the accepted scalars.
        return json_decode(ClawPilotNativeEmailAuthorityContract::canonical($value),true,16,JSON_THROW_ON_ERROR);
    }
    private static function keys(mixed $value,array $expected): void
    {
        self::need(is_array($value),'shape');$actual=array_keys($value);sort($actual,SORT_STRING);sort($expected,SORT_STRING);
        self::need($actual===$expected,'shape');
    }
    private static function hash(mixed $value): bool
    {return is_string($value)&&preg_match('/^[a-f0-9]{64}$/D',$value)===1;}
    private static function need(bool $condition,string $code): void
    {if(!$condition)throw new ClawPilotNativeEmailTransactionRefused('initial_installation_lineage_'.$code);}
}
