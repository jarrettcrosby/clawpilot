<?php
declare(strict_types=1);
// Bounded disposable meeting HTTP bridge/observer, not a production endpoint.
// No fake OAuth/V8 responses, direct meeting writes, hooks, or permission edits.
if(PHP_SAPI!=='cli'||getenv('CLAWPILOT_NATIVE_INITIAL_FIXTURE')!=='1'
    ||getenv('CLAWPILOT_NATIVE_JOINT_MEETING_ROUNDTRIP')!=='1'||posix_geteuid()!==0||count($argv)!==2)
    throw new RuntimeException('Explicit isolated joint meeting fixture required');
define('CP_JOINT_LIFECYCLE_INCLUDE_ONLY',true);require __DIR__.'/native-joint-lifecycle.php';
$state=cp_joint_lifecycle_control();cp_joint_lifecycle_need(($state['meetingRoundtrip']??false)===true,'meeting_opt_in');
$mode=$argv[1];
if($mode==='credentials'){
    // Root0600 file -> local in-memory pipe only; never include in evidence.
    cp_joint_lifecycle_need(is_string($state['clientSecret']??null)&&strlen($state['clientSecret'])>=32,'retained_synthetic_secret');
    fwrite(STDOUT,json_encode(['suiteCrmBaseUrl'=>'https://suitecrm-joint.example.invalid/legacy',
        'clientId'=>$state['clientId'],'clientSecret'=>$state['clientSecret'],'accessToken'=>$state['accessToken'],
        'nativeAccountId'=>$state['records'][0]['nativeId'],'accountReferenceCode'=>$state['records'][0]['globalId'],
        'nativeContactId'=>$state['records'][1]['nativeId'],'contactReferenceCode'=>$state['records'][1]['globalId'],
        'contactEmail'=>$state['contactEmail']],JSON_THROW_ON_ERROR));return;
}
$bytes=stream_get_contents(STDIN,262145);cp_joint_lifecycle_need(is_string($bytes)&&strlen($bytes)<=262144,'bounded_stdin');
$input=json_decode($bytes,true,24,JSON_THROW_ON_ERROR);cp_joint_lifecycle_need(is_array($input),'wire_object');
if($mode==='request'){
    cp_joint_lifecycle_need(array_keys($input)===['url','method','headers','body'],'wire_shape');
    $url=parse_url($input['url']);$path=$url['path']??'';$method=$input['method'];$body=$input['body'];
    cp_joint_lifecycle_need(is_array($url)&&($url['scheme']??'')==='https'&&($url['host']??'')==='suitecrm-joint.example.invalid'
        &&!isset($url['user'])&&!isset($url['pass'])&&!isset($url['port'])&&!isset($url['fragment'])
        &&is_string($path)&&str_starts_with($path,'/legacy/Api/')&&strlen($input['url'])<=4096
        &&in_array($method,['GET','POST','PATCH'],true)&&is_array($input['headers'])&&array_is_list($input['headers'])
        &&($body===null||is_string($body)&&strlen($body)<=200000),'local_only_request');
    $grant=$path==='/legacy/Api/access_token'&&$method==='POST';
    $module=$path==='/legacy/Api/V8/module'&&in_array($method,['POST','PATCH'],true);
    $get=$method==='GET'&&preg_match('~^/legacy/Api/V8/module/(?:Meetings(?:/[a-zA-Z0-9-]{1,64}(?:/relationships/(?:contacts|accounts))?)?|(?:Accounts|Contacts)/[a-zA-Z0-9-]{1,64})$~D',$path)===1;
    $relationship=$method==='POST'&&preg_match('~^/legacy/Api/V8/module/Meetings/[a-zA-Z0-9-]{1,64}/relationships/(?:contacts|accounts)$~D',$path)===1;
    cp_joint_lifecycle_need($grant||$module||$get||$relationship,'bounded_native_endpoint');
    if($grant){$payload=json_decode($body,true,8,JSON_THROW_ON_ERROR);
        cp_joint_lifecycle_need($payload===['grant_type'=>'client_credentials','client_id'=>$state['clientId'],'client_secret'=>$state['clientSecret']],'exact_synthetic_grant');}
    if($module){$payload=json_decode($body,true,16,JSON_THROW_ON_ERROR);
        cp_joint_lifecycle_need(($payload['data']['type']??null)==='Meetings'
            &&preg_match('/^[a-f0-9-]{36}$/Di',(string)($payload['data']['id']??''))===1,'meeting_only_write');}
    if($module){$attributes=$payload['data']['attributes']??null;
        cp_joint_lifecycle_need(is_array($attributes)&&!array_is_list($attributes),'meeting_attributes');
        foreach(array_keys($attributes) as $field)cp_joint_lifecycle_need(in_array($field,
            ['global_id_c','name','description','date_start','date_end','duration_hours','duration_minutes','status','location','parent_id','parent_type'],true),'scalar_meeting_field');}
    if($relationship){$payload=json_decode($body,true,8,JSON_THROW_ON_ERROR);$account=str_ends_with($path,'/accounts');
        cp_joint_lifecycle_need($payload===['data'=>['type'=>$account?'Accounts':'Contacts','id'=>$state['records'][$account?0:1]['nativeId']]],'exact_fixture_relationship');}
    $headers=[];foreach($input['headers'] as $header){cp_joint_lifecycle_need(is_array($header)&&count($header)===2
        &&in_array(strtolower($header[0]),['accept','content-type','authorization'],true)
        &&is_string($header[1])&&strlen($header[1])<=8192&&!str_contains($header[1],"\r")&&!str_contains($header[1],"\n"),'bounded_header');
        $headers[]=$header[0].': '.$header[1];}
    $target='http://127.0.0.1:8080'.$path.(isset($url['query'])?'?'.$url['query']:'');$curl=curl_init($target);$responseHeaders=[];$responseBody='';
    curl_setopt_array($curl,[CURLOPT_CUSTOMREQUEST=>$method,CURLOPT_HTTPHEADER=>$headers,CURLOPT_RETURNTRANSFER=>false,
        CURLOPT_FOLLOWLOCATION=>false,CURLOPT_PROXY=>'',CURLOPT_CONNECTTIMEOUT=>2,CURLOPT_TIMEOUT=>6,CURLOPT_PROTOCOLS=>CURLPROTO_HTTP,
        CURLOPT_WRITEFUNCTION=>static function($curl,string $chunk)use(&$responseBody):int{
            if(strlen($responseBody)+strlen($chunk)>2097152)return 0;$responseBody.=$chunk;return strlen($chunk);},
        CURLOPT_HEADERFUNCTION=>static function($curl,string $line)use(&$responseHeaders):int{
            if(str_starts_with($line,'HTTP/'))$responseHeaders=[];
            elseif(($colon=strpos($line,':'))!==false){if(count($responseHeaders)>=64)return 0;
                $responseHeaders[]=[strtolower(trim(substr($line,0,$colon))),trim(substr($line,$colon+1))];}return strlen($line);}]);
    if($body!==null)curl_setopt($curl,CURLOPT_POSTFIELDS,$body);
    $ok=curl_exec($curl);$status=(int)curl_getinfo($curl,CURLINFO_RESPONSE_CODE);$error=curl_errno($curl);curl_close($curl);
    cp_joint_lifecycle_need($ok!==false&&$error===0&&$status>=100&&$status<=599,'actual_http_completed');
    fwrite(STDOUT,json_encode(['status'=>$status,'headers'=>$responseHeaders,'body'=>$responseBody],JSON_THROW_ON_ERROR));return;
}
cp_joint_lifecycle_need($mode==='rows'&&array_keys($input)===['nativeMeetingId']
    &&($input['nativeMeetingId']===null||is_string($input['nativeMeetingId'])&&preg_match('/^[a-f0-9-]{36}$/Di',$input['nativeMeetingId'])===1),'row_observer_shape');
$meeting=$input['nativeMeetingId'];$database=new mysqli('db','fixture','Synthetic-native-db-password-only','suitecrm_native_test',3306);$database->set_charset('utf8mb4');
$out=[];
foreach(['meetings'=>'id','meetings_cstm'=>'id_c','meetings_contacts'=>'meeting_id','meetings_users'=>'meeting_id','meetings_audit'=>'parent_id','oauth2tokens'=>'client','vcals'=>'user_id','accounts'=>'id','contacts'=>'id'] as $table=>$key){
    $exists=$database->query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='".$table."'")->num_rows===1;
    if(!$exists){$out[$table]=null;continue;}
    $result=$database->query('SELECT * FROM `'.$table.'`');$selected=[];$other=[];$size=0;
    while($row=$result->fetch_assoc()){$encoded=json_encode($row,JSON_THROW_ON_ERROR);$size+=strlen($encoded);
        cp_joint_lifecycle_need(count($other)+count($selected)<50000&&$size<16777216,'bounded_row_audit');
        $selectedId=match($table){'oauth2tokens'=>$state['clientId'],'accounts'=>$state['records'][0]['nativeId'],
            'contacts'=>$state['records'][1]['nativeId'],default=>$meeting};
        $selectedRow=$table==='vcals'?($row['user_id']===$state['adminId']&&$row['type']==='vfb'&&$row['source']==='sugar'&&(string)$row['deleted']==='0')
            :(($row[$key]??null)===$selectedId);
        if($selectedRow)$selected[]=$row;else $other[]=$encoded;}
    usort($selected,static fn(array $a,array $b):int=>strcmp(json_encode($a),json_encode($b)));sort($other,SORT_STRING);
    $out[$table]=['selected'=>$selected,'otherSha256'=>hash('sha256',implode("\n",$other)),'otherCount'=>count($other)];
}
$database->close();fwrite(STDOUT,json_encode($out,JSON_THROW_ON_ERROR));
