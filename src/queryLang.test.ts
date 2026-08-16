import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildQuery,
  escapeValue,
  isInternalLabel,
  isMalformedQuery,
  isValidLabelName,
  malformedQueryReason,
  parseQuery,
  splitQuery,
  toDisplayLabel,
  toInternalLabel,
  upsertMatcher,
} from './queryLang.ts';

const CPU = 'process_cpu:cpu:nanoseconds:cpu:nanoseconds';
const MEM = 'memory:alloc_space:bytes:space:bytes';

describe('splitQuery', () => {
  it('splits profile_type out of a basic query', () => {
    assert.deepEqual(
      splitQuery(`{service_name="checkout", profile_type="${CPU}"}`),
      {
        profileTypeID: CPU,
        labelSelector: '{service_name="checkout"}',
      },
    );
  });

  it('returns an empty selector when only profile_type is present', () => {
    assert.deepEqual(splitQuery(`{profile_type="${CPU}"}`), {
      profileTypeID: CPU,
      labelSelector: '{}',
    });
  });

  it('preserves other matchers, their operators, and their order', () => {
    const { profileTypeID, labelSelector } = splitQuery(
      `{service_name="a", region=~"us-.*", pod!="p-1", ns!~"kube.*", profile_type="${CPU}"}`,
    );
    assert.equal(profileTypeID, CPU);
    assert.equal(
      labelSelector,
      '{service_name="a", region=~"us-.*", pod!="p-1", ns!~"kube.*"}',
    );
  });

  it('handles profile_type appearing first', () => {
    assert.deepEqual(splitQuery(`{profile_type="${CPU}", region="eu"}`), {
      profileTypeID: CPU,
      labelSelector: '{region="eu"}',
    });
  });

  it('accepts the internal __profile_type__ spelling', () => {
    assert.deepEqual(
      splitQuery(`{__profile_type__="${CPU}", service_name="a"}`),
      { profileTypeID: CPU, labelSelector: '{service_name="a"}' },
    );
  });

  it('dedupes identical profile_type= matchers, keeping the value', () => {
    const { profileTypeID } = splitQuery(
      `{profile_type="${CPU}", profile_type="${CPU}"}`,
    );
    assert.equal(profileTypeID, CPU);
  });

  it('drops the profileTypeID when profile_type= matchers disagree', () => {
    // {profile_type="cpu", profile_type="memory"} matches nothing under
    // PromQL semantics; sending either value would misreport that as real
    // data, so the pseudo-label collapses to no ID rather than "last wins".
    const { profileTypeID } = splitQuery(
      `{profile_type="${CPU}", profile_type="${MEM}"}`,
    );
    assert.equal(profileTypeID, '');
  });

  it('tolerates arbitrary whitespace', () => {
    assert.deepEqual(
      splitQuery(`  {  service_name = "a" ,\n\tprofile_type\t=  "${CPU}"  }  `),
      { profileTypeID: CPU, labelSelector: '{service_name="a"}' },
    );
  });

  it('normalizes formatting so equivalent queries yield identical selectors', () => {
    const a = splitQuery(
      `{service_name="a",region="eu",profile_type="${CPU}"}`,
    );
    const b = splitQuery(
      `{ service_name = "a" , region = "eu" , profile_type = "${CPU}" }`,
    );
    assert.deepEqual(a, b);
  });

  it('tolerates a trailing comma', () => {
    assert.deepEqual(splitQuery(`{profile_type="${CPU}",}`), {
      profileTypeID: CPU,
      labelSelector: '{}',
    });
  });

  it('preserves escaped quotes and backslashes in values', () => {
    const { labelSelector } = splitQuery(
      `{note="say \\"hi\\"", path="C:\\\\tmp", profile_type="${CPU}"}`,
    );
    assert.equal(labelSelector, '{note="say \\"hi\\"", path="C:\\\\tmp"}');
  });

  it('preserves values containing commas and braces', () => {
    const { labelSelector } = splitQuery(
      `{x="a,b", y="{c}", profile_type="${CPU}"}`,
    );
    assert.equal(labelSelector, '{x="a,b", y="{c}"}');
  });

  it('returns empty results for an empty query', () => {
    assert.deepEqual(splitQuery(''), {
      profileTypeID: '',
      labelSelector: '{}',
    });
  });

  it('returns empty results for an empty selector', () => {
    assert.deepEqual(splitQuery('{}'), {
      profileTypeID: '',
      labelSelector: '{}',
    });
  });

  it('returns empty results for unparseable input', () => {
    for (const bad of [
      'garbage',
      '{unclosed="a"',
      '{a="b" c="d"}',
      '{a=b}',
      '{=~"x"}',
      '{a=="b"}',
      '{a="b\\"}',
      '{1bad="x"}',
    ]) {
      assert.deepEqual(
        splitQuery(bad),
        { profileTypeID: '', labelSelector: '{}' },
        `input: ${bad}`,
      );
    }
  });

  it('ignores non-equality profile_type matchers for the ID but removes them', () => {
    assert.deepEqual(splitQuery(`{profile_type=~"process.*", region="eu"}`), {
      profileTypeID: '',
      labelSelector: '{region="eu"}',
    });
  });

  it('drops the profileTypeID when an = matcher mixes with a non-= one', () => {
    // {profile_type="A", profile_type=~"B.*"} is unsatisfiable-or-ambiguous
    // the same way two conflicting = values are: sending "A" alone would
    // silently drop the =~ constraint while still returning data, which is
    // worse than sending nothing.
    assert.deepEqual(
      splitQuery(`{profile_type="${CPU}", profile_type=~"mem.*"}`),
      { profileTypeID: '', labelSelector: '{}' },
    );
  });
});

describe('parseQuery', () => {
  it('extracts service and profile type', () => {
    assert.deepEqual(
      parseQuery(`{service_name="checkout", profile_type="${CPU}"}`),
      { service: 'checkout', profileType: CPU },
    );
  });

  it('is order-independent and ignores extra matchers', () => {
    assert.deepEqual(
      parseQuery(
        `{region=~"us-.*", profile_type="${CPU}", service_name="checkout"}`,
      ),
      { service: 'checkout', profileType: CPU },
    );
  });

  it('accepts the internal __profile_type__ spelling', () => {
    assert.deepEqual(
      parseQuery(`{service_name="s", __profile_type__="${CPU}"}`),
      { service: 's', profileType: CPU },
    );
  });

  it('tolerates whitespace', () => {
    assert.deepEqual(
      parseQuery(`{ service_name = "s" , profile_type = "${CPU}" }`),
      { service: 's', profileType: CPU },
    );
  });

  it('returns null when profile_type is missing', () => {
    assert.equal(parseQuery('{service_name="s"}'), null);
  });

  it('returns null when service_name is missing', () => {
    assert.equal(parseQuery(`{profile_type="${CPU}"}`), null);
  });

  it('only honors equality matchers', () => {
    assert.equal(
      parseQuery(`{service_name=~"s.*", profile_type="${CPU}"}`),
      null,
    );
    assert.equal(
      parseQuery(`{service_name="s", profile_type!="${CPU}"}`),
      null,
    );
  });

  it('returns null for empty or unparseable input', () => {
    assert.equal(parseQuery(''), null);
    assert.equal(parseQuery('{}'), null);
    assert.equal(parseQuery('nonsense{'), null);
  });

  it('lets the last equality matcher win for service_name, an ordinary label', () => {
    assert.deepEqual(
      parseQuery(`{service_name="a", service_name="b", profile_type="${CPU}"}`),
      { service: 'b', profileType: CPU },
    );
  });

  it('returns null when profile_type= matchers disagree, rather than picking the last', () => {
    // Unlike service_name, the pseudo-label cannot use "last one wins": the
    // cascade picker would display a value the query never unambiguously
    // asked for, while the request the query maps to is unfetchable.
    assert.equal(
      parseQuery(
        `{service_name="a", profile_type="${CPU}", profile_type="${MEM}"}`,
      ),
      null,
    );
  });

  it('returns null when a non-equality matcher joins an equality one on the pseudo-label', () => {
    assert.equal(
      parseQuery(
        `{service_name="a", profile_type="${CPU}", profile_type=~"mem.*"}`,
      ),
      null,
    );
  });
});

describe('buildQuery', () => {
  it('builds the canonical display query', () => {
    assert.equal(
      buildQuery('checkout', CPU),
      `{service_name="checkout", profile_type="${CPU}"}`,
    );
  });

  it('round-trips through parseQuery', () => {
    assert.deepEqual(parseQuery(buildQuery('svc', MEM)), {
      service: 'svc',
      profileType: MEM,
    });
  });

  it('round-trips through splitQuery', () => {
    assert.deepEqual(splitQuery(buildQuery('svc', CPU)), {
      profileTypeID: CPU,
      labelSelector: '{service_name="svc"}',
    });
  });

  it('escapes quotes and backslashes in inputs', () => {
    const q = buildQuery('we"ird\\svc', CPU);
    assert.equal(q, `{service_name="we\\"ird\\\\svc", profile_type="${CPU}"}`);
    assert.deepEqual(parseQuery(q), {
      service: 'we"ird\\svc',
      profileType: CPU,
    });
  });
});

describe('isInternalLabel', () => {
  it('flags dunder labels', () => {
    assert.equal(isInternalLabel('__session_id__'), true);
    assert.equal(isInternalLabel('__name__'), true);
    assert.equal(isInternalLabel('__profile_type__'), true);
  });

  it('rejects ordinary labels', () => {
    assert.equal(isInternalLabel('service_name'), false);
    assert.equal(isInternalLabel('region'), false);
    assert.equal(isInternalLabel('profile_type'), false);
    assert.equal(isInternalLabel('_private_'), false);
    assert.equal(isInternalLabel('__leading_only'), false);
    assert.equal(isInternalLabel('trailing_only__'), false);
  });

  it('rejects degenerate underscore-only names', () => {
    assert.equal(isInternalLabel(''), false);
    assert.equal(isInternalLabel('__'), false);
    assert.equal(isInternalLabel('____'), false);
  });
});

describe('toDisplayLabel / toInternalLabel', () => {
  it('maps __profile_type__ to profile_type and back', () => {
    assert.equal(toDisplayLabel('__profile_type__'), 'profile_type');
    assert.equal(toInternalLabel('profile_type'), '__profile_type__');
  });

  it('leaves ordinary labels untouched', () => {
    assert.equal(toDisplayLabel('region'), 'region');
    assert.equal(toDisplayLabel('service_name'), 'service_name');
    assert.equal(toInternalLabel('region'), 'region');
    assert.equal(toInternalLabel('service_name'), 'service_name');
  });

  it('leaves other internal labels untouched for isInternalLabel filtering', () => {
    assert.equal(toDisplayLabel('__session_id__'), '__session_id__');
  });

  it('round-trips both ways', () => {
    for (const name of ['profile_type', 'region', 'pod']) {
      assert.equal(toDisplayLabel(toInternalLabel(name)), name);
    }
    for (const name of ['__profile_type__', '__session_id__', 'region']) {
      assert.equal(toInternalLabel(toDisplayLabel(name)), name);
    }
  });
});

describe('upsertMatcher', () => {
  const base = `{service_name="a", profile_type="${CPU}"}`;

  it('appends a matcher for a new label', () => {
    assert.equal(
      upsertMatcher(base, 'region', 'us-east'),
      `{service_name="a", profile_type="${CPU}", region="us-east"}`,
    );
  });

  it('replaces an existing matcher in place', () => {
    assert.equal(
      upsertMatcher(
        `{service_name="a", region="us-east", profile_type="${CPU}"}`,
        'region',
        'eu-west',
      ),
      `{service_name="a", region="eu-west", profile_type="${CPU}"}`,
    );
  });

  it('replaces matchers regardless of their previous operator', () => {
    for (const op of ['=', '!=', '=~', '!~']) {
      assert.equal(
        upsertMatcher(`{region${op}"us-.*"}`, 'region', 'eu'),
        '{region="eu"}',
        `operator: ${op}`,
      );
    }
  });

  it('collapses duplicate matchers for the label', () => {
    assert.equal(
      upsertMatcher('{region="a", pod="p", region!="b"}', 'region', 'c'),
      '{region="c", pod="p"}',
    );
  });

  it('starts a selector from an empty query', () => {
    assert.equal(upsertMatcher('', 'region', 'eu'), '{region="eu"}');
    assert.equal(upsertMatcher('{}', 'region', 'eu'), '{region="eu"}');
  });

  it('leaves an unparseable query untouched', () => {
    // Rebuilding from nothing would silently discard every matcher the user
    // had — a drill-down click must not widen the query to the whole tenant.
    const malformed = '{service_name="checkout", region=';
    assert.equal(upsertMatcher(malformed, 'region', 'eu'), malformed);
  });

  it('escapes special characters in the new value', () => {
    assert.equal(
      upsertMatcher('{}', 'note', 'say "hi"\\now'),
      '{note="say \\"hi\\"\\\\now"}',
    );
  });

  it('keeps escaped values of untouched matchers intact', () => {
    assert.equal(
      upsertMatcher('{path="C:\\\\tmp"}', 'region', 'eu'),
      '{path="C:\\\\tmp", region="eu"}',
    );
  });

  it('tolerates whitespace in the input query', () => {
    assert.equal(
      upsertMatcher('{ region = "a" , pod = "p" }', 'region', 'b'),
      '{region="b", pod="p"}',
    );
  });

  it('feeds splitQuery correctly after upserting (Tag Explorer flow)', () => {
    const next = upsertMatcher(base, 'region', 'us-east');
    assert.deepEqual(splitQuery(next), {
      profileTypeID: CPU,
      labelSelector: '{service_name="a", region="us-east"}',
    });
  });
});

describe('value edge cases', () => {
  it('parses empty values', () => {
    assert.deepEqual(splitQuery(`{x="", profile_type="${CPU}"}`), {
      profileTypeID: CPU,
      labelSelector: '{x=""}',
    });
  });

  it('round-trips newline and tab escapes', () => {
    assert.equal(
      upsertMatcher('{x="a\\nb\\tc"}', 'y', 'z'),
      '{x="a\\nb\\tc", y="z"}',
    );
  });

  it('normalizes lone regex escapes without changing their meaning', () => {
    // `\.` is not a recognized string escape; the backslash is kept and
    // re-serialized in canonical `\\.` form (the same literal characters).
    assert.equal(
      splitQuery('{path=~"a\\.b", profile_type="x:y:z:a:b"}').labelSelector,
      '{path=~"a\\\\.b"}',
    );
  });

  it('handles unicode values', () => {
    assert.equal(upsertMatcher('{}', 'team', 'チーム'), '{team="チーム"}');
  });
});

describe('escapeValue', () => {
  it('escapes quotes and backslashes so values survive a round trip', () => {
    assert.equal(escapeValue('say "hi"'), 'say \\"hi\\"');
    assert.equal(escapeValue('C:\\temp\\app'), 'C:\\\\temp\\\\app');
    assert.equal(escapeValue('plain'), 'plain');
  });

  it('round-trips a hostile value through a selector', () => {
    const value = 'C:\\temp\\app "x"';
    const query = `{path="${escapeValue(value)}", profile_type="a:b:c:d:e"}`;
    assert.equal(
      splitQuery(query).labelSelector,
      `{path="${escapeValue(value)}"}`,
    );
  });
});

describe('isValidLabelName', () => {
  it('accepts label names and rejects injection attempts', () => {
    assert.equal(isValidLabelName('region'), true);
    assert.equal(isValidLabelName('__profile_type__'), true);
    assert.equal(isValidLabelName('region="x", pod'), false);
    assert.equal(isValidLabelName('9lives'), false);
    assert.equal(isValidLabelName(''), false);
  });
});

describe('upsertMatcher label validation', () => {
  it('ignores an injected label instead of smuggling matchers in', () => {
    const query = '{service_name="a", profile_type="x:y:z:a:b"}';
    assert.equal(upsertMatcher(query, 'region="injected", pod', 'v'), query);
  });
});

describe('isMalformedQuery', () => {
  it('separates blank from malformed', () => {
    assert.equal(isMalformedQuery(''), false);
    assert.equal(isMalformedQuery('   '), false);
    assert.equal(isMalformedQuery('{service_name="a"}'), false);
    assert.equal(isMalformedQuery('this is garbage {{{'), true);
    assert.equal(isMalformedQuery('{unclosed="a"'), true);
  });

  it('rejects a profile_type the API cannot express', () => {
    // The querier takes one profileTypeID, so a regex or a negation on the
    // pseudo-label can be neither sent nor honoured. splitQuery drops it, so
    // without this the user's filter silently vanished from the request —
    // and when it was the only profile_type matcher, the screen just sat
    // blank with nothing to explain why.
    assert.equal(isMalformedQuery('{profile_type=~"process.*"}'), true);
    assert.equal(isMalformedQuery('{profile_type!="memory:a:b:c:d"}'), true);
    assert.equal(isMalformedQuery('{__profile_type__!~"x"}'), true);
    assert.equal(
      isMalformedQuery('{service_name="a", profile_type="cpu:a:b:c:d"}'),
      false,
    );
  });

  it('rejects conflicting profile_type= matchers as unsatisfiable', () => {
    // {profile_type="cpu-id", profile_type="memory-id"} matches nothing;
    // treating it as "last one wins" would silently send whichever value
    // happened to be last instead of telling the user their query is empty.
    assert.equal(
      isMalformedQuery(`{profile_type="${CPU}", profile_type="${MEM}"}`),
      true,
    );
    assert.deepEqual(
      splitQuery(`{profile_type="${CPU}", profile_type="${MEM}"}`),
      { profileTypeID: '', labelSelector: '{}' },
    );
  });

  it('accepts identical duplicate profile_type= matchers', () => {
    assert.equal(
      isMalformedQuery(`{profile_type="${CPU}", profile_type="${CPU}"}`),
      false,
    );
    assert.deepEqual(
      splitQuery(`{profile_type="${CPU}", profile_type="${CPU}"}`),
      { profileTypeID: CPU, labelSelector: '{}' },
    );
  });

  it('rejects profile_type and __profile_type__ disagreeing across spellings', () => {
    assert.equal(
      isMalformedQuery(`{profile_type="${CPU}", __profile_type__="${MEM}"}`),
      true,
    );
  });

  it('accepts profile_type and __profile_type__ agreeing across spellings', () => {
    assert.equal(
      isMalformedQuery(`{profile_type="${CPU}", __profile_type__="${CPU}"}`),
      false,
    );
  });
});

describe('malformedQueryReason', () => {
  it('is null for blank and well-formed queries', () => {
    assert.equal(malformedQueryReason(''), null);
    assert.equal(malformedQueryReason('   '), null);
    assert.equal(malformedQueryReason('{service_name="a"}'), null);
    assert.equal(
      malformedQueryReason(`{service_name="a", profile_type="${CPU}"}`),
      null,
    );
  });

  it('is "syntax" for input that does not parse', () => {
    assert.equal(malformedQueryReason('this is garbage {{{'), 'syntax');
    assert.equal(malformedQueryReason('{unclosed="a"'), 'syntax');
  });

  it('is "profileType" for a parseable but unsupported pseudo-label constraint', () => {
    // Distinct from 'syntax' so a caller can point at the real problem — a
    // regex/negation, or conflicting values — instead of blaming syntax for
    // a query that parsed fine.
    assert.equal(
      malformedQueryReason('{profile_type=~"process.*"}'),
      'profileType',
    );
    assert.equal(
      malformedQueryReason(`{profile_type="${CPU}", profile_type="${MEM}"}`),
      'profileType',
    );
    assert.equal(
      malformedQueryReason(`{profile_type="${CPU}", profile_type=~"mem.*"}`),
      'profileType',
    );
  });

  it('prefers "syntax" over "profileType" when both would apply', () => {
    // An input that fails to parse never reaches the pseudo-label check.
    assert.equal(malformedQueryReason('{profile_type=~'), 'syntax');
  });

  it('is "profileType" for an explicit empty profile_type value', () => {
    // profile_type="" parses fine and is a single distinct = value, so
    // without this it read as "usable" while the querier's profileTypeID
    // can never be empty — the user's explicit constraint would otherwise
    // fetch nothing with no message explaining why.
    assert.equal(malformedQueryReason('{profile_type=""}'), 'profileType');
  });

  it('stays null when no pseudo-label matcher is present at all', () => {
    // Distinct from an explicit profile_type="": this is "nothing selected
    // yet", the state the default-query effect handles, not a malformed one.
    assert.equal(malformedQueryReason('{service_name="s"}'), null);
  });
});

describe('empty profile_type value', () => {
  it('splitQuery yields an empty profileTypeID for an explicit empty value', () => {
    assert.deepEqual(splitQuery('{profile_type=""}'), {
      profileTypeID: '',
      labelSelector: '{}',
    });
  });

  it('parseQuery returns null for an explicit empty profile_type value', () => {
    assert.equal(parseQuery('{service_name="s", profile_type=""}'), null);
  });
});
