package main

import "testing"

func TestParseTransmitArgs(t *testing.T) {
	flags, inURI, outURI, ok := ParseTransmitArgs([]string{
		"-stats:1500",
		"-statspf:json",
		"srt://:21115?rcvbuf=33554432",
		"srt://:11115?rcvbuf=33554432",
	})
	if !ok {
		t.Fatalf("expected ok=true")
	}
	if len(flags) != 2 || flags[0] != "-stats:1500" || flags[1] != "-statspf:json" {
		t.Fatalf("unexpected flags: %v", flags)
	}
	if inURI != "srt://:21115?rcvbuf=33554432" || outURI != "srt://:11115?rcvbuf=33554432" {
		t.Fatalf("unexpected URIs: in=%q out=%q", inURI, outURI)
	}
}

func TestDeriveEgressUDPPort(t *testing.T) {
	p, err := DeriveEgressUDPPort("127.0.0.1:29115", "")
	if err != nil || p != 27115 {
		t.Fatalf("got (%d, %v), want (27115, nil)", p, err)
	}
	p2, err := DeriveEgressUDPPort("127.0.0.1:29115", "28500")
	if err != nil || p2 != 28500 {
		t.Fatalf("override got (%d, %v), want (28500, nil)", p2, err)
	}
}
