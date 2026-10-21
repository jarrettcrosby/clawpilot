<?php
// ClawPilot managed email search presentation v1.
// Native Meeting queries must page meetings, not their attendee join rows.
if (!defined('sugarEntry') || !sugarEntry) {
    die('Not A Valid Entry Point');
}

require_once 'modules/Meetings/Meeting.php';

class ClawPilotMeeting extends Meeting
{
    public function create_new_list_query(
        $order_by,
        $where,
        $filter = [],
        $params = [],
        $show_deleted = 0,
        $join_type = '',
        $return_array = false,
        $parentbean = null,
        $singleSelect = false,
        $ifListForExport = false
    ) {
        // Native two-phase callers and exports already own their projection.
        if (!$singleSelect || $ifListForExport) {
            return parent::create_new_list_query(
                $order_by, $where, $filter, $params, $show_deleted,
                $join_type, $return_array, $parentbean, $singleSelect, $ifListForExport
            );
        }

        $params['distinct'] = true;
        $parts = parent::create_new_list_query(
            $order_by, $where, $filter, $params, $show_deleted,
            $join_type, true, $parentbean, false, $ifListForExport
        );

        // SuiteCRM 8.10.1 builds M:M attendee projections in secondary_select.
        // Keep those values out of the primary DISTINCT projection, but retain
        // the exact native joins so related-contact predicates still work. ACL,
        // deletion predicates, custom fields and native sort validation remain
        // entirely the parent's. ListViewData performs the secondary hydration;
        // V8 separately retrieves each returned bean ID before serialization.
        $baseFrom = ' FROM ' . $this->table_name . ' ';
        $secondaryFrom = $parts['secondary_from'] ?? $baseFrom;
        if (!is_string($secondaryFrom) || !str_starts_with($secondaryFrom, $baseFrom)) {
            throw new RuntimeException('Unexpected native Meeting secondary query shape');
        }
        $parts['from'] .= substr($secondaryFrom, strlen($baseFrom));
        $parts['select'] = preg_replace('/^\s*SELECT\s+/i', ' SELECT /* ClawPilotMeetingList:v1 */ ', $parts['select'], 1);

        // A Meeting has many contacts, so contact sorting needs one stable value
        // per meeting. Use the first alphabetical active attendee, never drop
        // links or arbitrarily choose a joined row before LIMIT. These are fixed
        // native field/alias names, not request-supplied SQL.
        foreach (['contact_name', 'contact_id'] as $field) {
            if (!preg_match('/(?:^|[\s,.])' . $field . '(?:[\s,]|$)/i', (string) $order_by)) {
                continue;
            }
            $value = $field === 'contact_id'
                ? 'cp_contact.id'
                : $this->db->concat('cp_contact', ['first_name', 'last_name']);
            $scalar = '(SELECT MIN(' . $value . ') FROM meetings_contacts cp_attendee'
                . ' INNER JOIN contacts cp_contact ON cp_contact.id = cp_attendee.contact_id'
                . ' AND cp_contact.deleted = 0 WHERE cp_attendee.meeting_id = meetings.id'
                . ' AND cp_attendee.deleted = 0)';
            $pattern = '/,\s*\'[ ]+\'\s+' . $field . '\b/i';
            $parts['select'] = preg_replace($pattern, ', ' . $scalar . ' ' . $field, $parts['select']);
        }

        if ($return_array) {
            return $parts;
        }
        return $parts['select'] . $parts['from'] . $parts['where'] . $parts['order_by'];
    }

    public function create_list_count_query($query, $alias = 'c')
    {
        if (!is_string($query) || !str_contains($query, '/* ClawPilotMeetingList:v1 */')) {
            return parent::create_list_count_query($query, $alias);
        }
        // The native regex count rewriter stops at the first FROM, including a
        // contact-sort scalar subquery. Count the actual unique meeting query,
        // preserving all of its ACL/filter semantics and native sorting.
        if (is_array($alias)) {
            $alias = $alias[0] ?? '';
        }
        if (!is_string($alias) || !preg_match('/\A[A-Za-z_][A-Za-z0-9_]*\z/D', $alias)) {
            throw new InvalidArgumentException('Invalid Meeting count alias');
        }
        return 'SELECT COUNT(*) ' . $alias . ' FROM (' . $query . ') cp_meeting_list_count';
    }
}
