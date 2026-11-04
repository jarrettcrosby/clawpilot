<?php
// Sequencing stand-in only. Real native action refresh is tested separately.
class ACLAction {
    public static array $calls=[];
    public static function getUserActions(string $id,bool $force):void {self::$calls[]=[$id,$force];}
}
