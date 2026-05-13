"""End-to-end test: match timeslot → build doc name → find document."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / 'scripts'))

from match_and_insert import match_timeslot, build_doc_name


def test_match_timeslot_all_cases():
    """Verify all representative time matching cases."""
    cases = [
        ('06:58', '门口值日1'),   # before first slot, lookahead
        ('07:35', '门口值日1'),   # exact start
        ('07:59', '门口值日1'),   # in range
        ('08:01', '早读'),        # tolerance wins when event started
        ('08:19', '阳光运动'),    # near point event
        ('09:30', '课间值日'),    # exact start of recess
        ('12:20', '门口值日2'),   # overlap: 12:10-12:30 vs 12:15-12:35, pick earlier start
        ('14:00', '门口值日3'),   # overlap: 13:55-14:15 (20 min) vs 12:45-14:00 (75 min), shorter wins
        ('15:05', '下午课间1'),   # in range
        ('16:30', '巡晚托'),      # exact start
        ('17:58', '门口值日5'),   # overlap: 17:55-18:15 vs 16:30-18:00
    ]
    for hhmm, expected_section in cases:
        result = match_timeslot(hhmm)
        assert result is not None, f'{hhmm}: no match found'
        assert result['section'] == expected_section, \
            f'{hhmm}: expected {expected_section}, got {result["section"]}'


def test_no_match_out_of_range():
    """Times far outside all slots should return None."""
    assert match_timeslot('02:00') is None
    assert match_timeslot('03:00') is None
    assert match_timeslot('22:00') is None
    assert match_timeslot('23:59') is None


def test_build_doc_name():
    """Verify document name building handles all formats correctly."""
    assert build_doc_name('东校区', '2026.04.29') == '东校区2026年4月29日教师值班记录.docx'
    assert build_doc_name('西校区', '2026.05.08') == '西校区2026年5月8日教师值班记录.docx'
    assert build_doc_name('东校区', '2026.11.15') == '东校区2026年11月15日教师值班记录.docx'
    assert build_doc_name('西校区', '2026.12.01') == '西校区2026年12月1日教师值班记录.docx'


def test_date_month_no_leading_zero():
    """Months and days should NOT have leading zeros (matching existing format)."""
    name = build_doc_name('东校区', '2026.04.09')
    assert '04月' not in name, f'Month should not have leading zero: {name}'
    assert '09日' not in name, f'Day should not have leading zero: {name}'
    assert name == '东校区2026年4月9日教师值班记录.docx'


if __name__ == '__main__':
    test_match_timeslot_all_cases()
    test_no_match_out_of_range()
    test_build_doc_name()
    test_date_month_no_leading_zero()
    print('All tests passed!')
