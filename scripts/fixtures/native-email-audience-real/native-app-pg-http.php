<?php
declare(strict_types=1);
// A tunnel to actual loopback HTTP, not a fake native response. No host port or
// provider connection is needed. Synthetic request credentials remain on stdin.
if(PHP_SAPI!=='cli' || getenv('CLAWPILOT_NATIVE_FIXTURE_APP_PG')!=='1')throw new RuntimeException('Combined disposable bridge required');
$input=json_decode((string)stream_get_contents(STDIN),true,16,JSON_THROW_ON_ERROR);
$path=$input['path']??'';$body=$input['body']??null;$headers=$input['headers']??null;
if(!is_string($path)||!preg_match('~^/Api/(?:access_token|V8/custom/clawpilot-email-authority/(?:inspect|project|approve|execute|resolve|cancel-expired))$~D',$path)
    ||!is_string($body)||strlen($body)>820000||!is_array($headers)||count($headers)>4)throw new RuntimeException('Exact bounded native HTTP request required');
$request=[];foreach($headers as $name=>$value){
    if(!in_array(strtolower($name),['content-type','accept','authorization'],true)||!is_string($value)
        ||strlen($value)>8192||strpbrk($value,"\r\n")!==false)throw new RuntimeException('Bounded header required');
    $request[]=$name.': '.$value;
}
$curl=curl_init();$output='';$responseHeaders=[];
curl_setopt_array($curl,[CURLOPT_URL=>'http://127.0.0.1:8099'.$path,CURLOPT_PROXY=>'',CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>$body,
    CURLOPT_HTTPHEADER=>$request,CURLOPT_CONNECTTIMEOUT=>2,CURLOPT_TIMEOUT=>18,CURLOPT_FOLLOWLOCATION=>false,
    CURLOPT_PROTOCOLS=>CURLPROTO_HTTP,CURLOPT_REDIR_PROTOCOLS=>CURLPROTO_HTTP,
    CURLOPT_WRITEFUNCTION=>static function($curl,string $chunk)use(&$output):int{if(strlen($output)+strlen($chunk)>1000000)return 0;$output.=$chunk;return strlen($chunk);},
    CURLOPT_HEADERFUNCTION=>static function($curl,string $line)use(&$responseHeaders):int{$parts=explode(':',$line,2);
        if(count($parts)===2)$responseHeaders[strtolower(trim($parts[0]))]=trim($parts[1]);return strlen($line);}]);
try{if(curl_exec($curl)===false)throw new RuntimeException('Native loopback transport unavailable');
    if(isset($responseHeaders['location']))throw new RuntimeException('Native redirect refused');
    fwrite(STDOUT,json_encode(['status'=>(int)curl_getinfo($curl,CURLINFO_RESPONSE_CODE),'body'=>$output,'headers'=>$responseHeaders],JSON_THROW_ON_ERROR)."\n");
}finally{curl_close($curl);}
