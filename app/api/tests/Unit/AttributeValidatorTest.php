<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\Service\AttributeValidator;

/**
 * Pinned behaviour for the kinds and display variants this branch
 * adds — dimension (new kind), and number display=duration/currency
 * (new variants on existing kind). The pre-existing kinds are
 * exercised live by the attribute / note-create feature tests; this
 * file just keeps the new surfaces honest.
 */

it('accepts a well-formed dimension value', function (): void {
    AttributeValidator::validateValue('size', 'dimension', [], ['width' => 1024, 'height' => 1536]);
    expect(true)->toBeTrue();
});

it('rejects a dimension value that is not an object', function (): void {
    expect(fn() => AttributeValidator::validateValue('size', 'dimension', [], '1024x1536'))
        ->toThrow(HttpError::class, 'dimension value must be an object');
});

it('rejects a dimension value with missing width', function (): void {
    expect(fn() => AttributeValidator::validateValue('size', 'dimension', [], ['height' => 1024]))
        ->toThrow(HttpError::class, 'width');
});

it('rejects a dimension value with zero or negative components', function (): void {
    expect(fn() => AttributeValidator::validateValue('size', 'dimension', [], ['width' => 0, 'height' => 1024]))
        ->toThrow(HttpError::class, 'width must be >= 1');
    expect(fn() => AttributeValidator::validateValue('size', 'dimension', [], ['width' => 1024, 'height' => -1]))
        ->toThrow(HttpError::class, 'height');
});

it('accepts numeric strings for dimension components (json coercion safety)', function (): void {
    AttributeValidator::validateValue('size', 'dimension', [], ['width' => '1024', 'height' => '1536']);
    expect(true)->toBeTrue();
});

it('accepts the new number display variants', function (): void {
    AttributeValidator::validateConfig('number', ['display' => 'duration']);
    AttributeValidator::validateConfig('number', ['display' => 'currency', 'currency' => 'USD']);
    AttributeValidator::validateConfig('number', ['display' => 'currency', 'currency' => 'EUR']);
    expect(true)->toBeTrue();
});

it('defaults currency to USD when display=currency but no code supplied', function (): void {
    // No exception — implicit default.
    AttributeValidator::validateConfig('number', ['display' => 'currency']);
    expect(true)->toBeTrue();
});

it('rejects malformed currency codes', function (): void {
    expect(fn() => AttributeValidator::validateConfig('number', ['display' => 'currency', 'currency' => 'usd']))
        ->toThrow(HttpError::class, 'currency must be a 3-letter');
    expect(fn() => AttributeValidator::validateConfig('number', ['display' => 'currency', 'currency' => 'EURO']))
        ->toThrow(HttpError::class, '3-letter');
});

it('rejects an unknown number display variant', function (): void {
    expect(fn() => AttributeValidator::validateConfig('number', ['display' => 'percentile']))
        ->toThrow(HttpError::class, 'number display must be');
});
