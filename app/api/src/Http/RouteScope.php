<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http;

use FastRoute\RouteCollector;

final class RouteScope
{
    private RouteCollector $routes;

    /** @var callable(string, Middleware): void */
    private $addPrefixMiddleware;

    private string $absolutePrefix;

    /** @param callable(string, Middleware): void $addPrefixMiddleware */
    public function __construct(RouteCollector $routes, callable $addPrefixMiddleware, string $absolutePrefix = '')
    {
        $this->routes = $routes;
        $this->addPrefixMiddleware = $addPrefixMiddleware;
        $this->absolutePrefix = $absolutePrefix;
    }

    public function group(string $prefix, callable $register): void
    {
        $absolute = $this->joinAbsolutePrefix($prefix);

        $this->routes->addGroup($prefix, function (RouteCollector $r) use (&$register, $absolute): void {
            $scope = new self($r, $this->addPrefixMiddleware, $absolute);
            $register($scope);
        });
    }

    public function use(string $pathPrefix, Middleware $middleware): void
    {
        $absolute = $this->joinAbsolutePrefix($pathPrefix);
        ($this->addPrefixMiddleware)($absolute, $middleware);
    }

    public function get(string $path, mixed $handler): void
    {
        $this->routes->addRoute('GET', $path, $handler);
    }

    public function post(string $path, mixed $handler): void
    {
        $this->routes->addRoute('POST', $path, $handler);
    }

    public function add(string $method, string $path, mixed $handler): void
    {
        $this->routes->addRoute($method, $path, $handler);
    }

    private function joinAbsolutePrefix(string $relative): string
    {
        $base = rtrim($this->absolutePrefix, '/');

        if ($relative === '') {
            return $base;
        }

        if ($relative[0] !== '/') {
            $relative = '/' . $relative;
        }

        if ($base === '') {
            return $relative;
        }

        return $base . $relative;
    }
}
