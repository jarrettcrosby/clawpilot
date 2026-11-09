-- No service, database, account, role, or Email is changed or printed.
START TRANSACTION READ ONLY;
SELECT JSON_OBJECT(
  'serverVersion',VERSION(),
  'schemaEngineCount',(SELECT COUNT(DISTINCT ENGINE) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()),
  'emailTemplateSidecar',(SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='emails_email_templates'),
  'emailDefaultCount',(SELECT COUNT(*) FROM acl_actions WHERE category='Emails' AND acltype='module' AND deleted=0 AND name IN ('view','list','export','edit','delete')),
  'stockEmailDefaults',(SELECT COUNT(*) FROM acl_actions WHERE category='Emails' AND acltype='module' AND deleted=0 AND name IN ('view','list','export','edit','delete') AND aclaccess=90),
  'activeWorkflows',(SELECT COUNT(*) FROM aow_workflow WHERE deleted=0 AND status='Active'),
  'defaultGroups',(SELECT COUNT(*) FROM securitygroups_default WHERE deleted=0),
  'activeNativeAdmins',(SELECT COUNT(*) FROM users WHERE deleted=0 AND status='Active' AND is_admin=1),
  'activeAdminClientCredentials',(SELECT COUNT(*) FROM oauth2clients c JOIN users u ON u.id=c.assigned_user_id AND u.deleted=0 AND u.status='Active' AND u.is_admin=1 WHERE c.deleted=0 AND c.allowed_grant_type='client_credentials'),
  'metadataGrants',(SELECT COUNT(DISTINCT PRIVILEGE_TYPE) FROM (SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',1)),'@',QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',-1))) UNION ALL SELECT PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA=DATABASE() AND GRANTEE=CONCAT(QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',1)),'@',QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',-1)))) g WHERE PRIVILEGE_TYPE IN ('EVENT','TRIGGER'))
);
ROLLBACK;
