/**
 * COUNT() query builder for the Step-2 filter editor (5B.3). Pinned-string tests
 * in the analysis.test.ts style — the emitted SOQL is a contract. Edge cases at
 * the bottom lock the S32 adversarial-review findings (no-space-after-paren,
 * compact WHERE(, standalone LIMIT).
 */
import { describe, it, expect } from 'vitest'
import { buildCountQuery } from '../src/main/engine/filterQuery'

describe('buildCountQuery', () => {
  it('emits a bare COUNT() when the clause is empty', () => {
    const q = buildCountQuery('Account', '')
    expect(q.soql).toBe('SELECT COUNT() FROM Account')
    expect(q.strippedClause).toBeNull()
  })

  it('wraps a simple WHERE clause', () => {
    const q = buildCountQuery('Opportunity', "StageName = 'Closed Won'")
    expect(q.soql).toBe("SELECT COUNT() FROM Opportunity WHERE StageName = 'Closed Won'")
    expect(q.strippedClause).toBeNull()
  })

  it('strips a leading WHERE the user typed (no WHERE WHERE)', () => {
    const q = buildCountQuery('Account', '  WHERE Name != null')
    expect(q.soql).toBe('SELECT COUNT() FROM Account WHERE Name != null')
  })

  it('strips a trailing top-level ORDER BY and surfaces it', () => {
    const q = buildCountQuery('Contact', 'AccountId != null ORDER BY CreatedDate DESC')
    expect(q.soql).toBe('SELECT COUNT() FROM Contact WHERE AccountId != null')
    expect(q.strippedClause).toBe('ORDER BY CreatedDate DESC')
  })

  it('strips ORDER BY + trailing LIMIT together (both invalid follow-ons)', () => {
    const q = buildCountQuery('Contact', 'Name != null ORDER BY Name LIMIT 5')
    expect(q.soql).toBe('SELECT COUNT() FROM Contact WHERE Name != null')
    expect(q.strippedClause).toBe('ORDER BY Name LIMIT 5')
  })

  it('does NOT strip an ORDER BY inside a subquery/semi-join', () => {
    const clause = 'Id IN (SELECT AccountId FROM Contact WHERE Name != null)'
    const q = buildCountQuery('Account', clause)
    expect(q.soql).toBe(`SELECT COUNT() FROM Account WHERE ${clause}`)
    expect(q.strippedClause).toBeNull()
  })

  it('does NOT match "order" inside another word (Reorder__c)', () => {
    const q = buildCountQuery('Account', 'Reorder__c = true')
    expect(q.soql).toBe('SELECT COUNT() FROM Account WHERE Reorder__c = true')
    expect(q.strippedClause).toBeNull()
  })

  it('does NOT strip an ORDER BY that appears inside a string literal', () => {
    const q = buildCountQuery('Account', "Name = 'ORDER BY hack'")
    expect(q.soql).toBe("SELECT COUNT() FROM Account WHERE Name = 'ORDER BY hack'")
    expect(q.strippedClause).toBeNull()
  })

  it('handles case-insensitive and multi-space ORDER   BY', () => {
    const q = buildCountQuery('Account', 'Name != null oRdEr   by Name')
    expect(q.soql).toBe('SELECT COUNT() FROM Account WHERE Name != null')
    expect(q.strippedClause).toBe('oRdEr   by Name')
  })

  // ── S32 review findings ──────────────────────────────────────────────────

  it('strips a top-level ORDER BY abutting a subquery close-paren (no space)', () => {
    const q = buildCountQuery('Account', 'Id IN (SELECT Id FROM Contact)ORDER BY Name')
    expect(q.soql).toBe('SELECT COUNT() FROM Account WHERE Id IN (SELECT Id FROM Contact)')
    expect(q.strippedClause).toBe('ORDER BY Name')
  })

  it('strips a compact leading WHERE( with no space', () => {
    const q = buildCountQuery('Account', "WHERE(Name = 'x')")
    expect(q.soql).toBe("SELECT COUNT() FROM Account WHERE (Name = 'x')")
    expect(q.strippedClause).toBeNull()
  })

  it('does NOT strip a leading WHERE inside a field name (Where__c)', () => {
    const q = buildCountQuery('Account', "Where__c = 'x'")
    expect(q.soql).toBe("SELECT COUNT() FROM Account WHERE Where__c = 'x'")
  })

  it('strips a STANDALONE trailing LIMIT (would otherwise silently cap the count)', () => {
    const q = buildCountQuery('Contact', 'Name != null LIMIT 100')
    expect(q.soql).toBe('SELECT COUNT() FROM Contact WHERE Name != null')
    expect(q.strippedClause).toBe('LIMIT 100')
  })

  it('strips a standalone trailing OFFSET', () => {
    const q = buildCountQuery('Contact', 'Name != null OFFSET 20')
    expect(q.soql).toBe('SELECT COUNT() FROM Contact WHERE Name != null')
    expect(q.strippedClause).toBe('OFFSET 20')
  })

  it('does NOT strip a LIMIT inside a subquery', () => {
    const clause = 'Id IN (SELECT Id FROM Contact LIMIT 5)'
    const q = buildCountQuery('Account', clause)
    expect(q.soql).toBe(`SELECT COUNT() FROM Account WHERE ${clause}`)
    expect(q.strippedClause).toBeNull()
  })

  it('does NOT match LIMIT inside a field name (LimitField__c)', () => {
    const q = buildCountQuery('Account', 'LimitField__c = 5')
    expect(q.soql).toBe('SELECT COUNT() FROM Account WHERE LimitField__c = 5')
    expect(q.strippedClause).toBeNull()
  })
})
