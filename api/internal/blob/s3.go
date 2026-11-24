package blob

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"slices"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type S3Config struct {
	Bucket          string
	Region          string
	Endpoint        string
	AccessKeyID     string
	SecretAccessKey string
	ForcePathStyle  bool
}

type S3 struct {
	client *s3.Client
	bucket string
}

func NewS3(ctx context.Context, c S3Config) (*S3, error) {
	opts := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(c.Region)}
	if c.AccessKeyID != "" || c.SecretAccessKey != "" {
		opts = append(opts, awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(c.AccessKeyID, c.SecretAccessKey, "")))
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return nil, err
	}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		if c.Endpoint != "" {
			o.BaseEndpoint = aws.String(c.Endpoint)
		}
		o.UsePathStyle = c.ForcePathStyle
	})
	return &S3{client: client, bucket: c.Bucket}, nil
}

func (s *S3) Ping(ctx context.Context) error {
	_, err := s.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(s.bucket)})
	if err != nil {
		return fmt.Errorf("%w: head bucket %q: %v", ErrStorage, s.bucket, err)
	}
	return nil
}

func (s *S3) Put(ctx context.Context, key, contentType string, body []byte) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key), Body: bytes.NewReader(body), ContentType: aws.String(contentType)})
	if err != nil {
		return fmt.Errorf("%w: put %q: %v", ErrStorage, key, err)
	}
	return nil
}
func (s *S3) Get(ctx context.Context, key string) ([]byte, string, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err != nil {
		if isNotFound(err) {
			return nil, "", ErrNotFound
		}
		return nil, "", fmt.Errorf("%w: get %q: %v", ErrStorage, key, err)
	}
	defer func() {
		_ = out.Body.Close()
	}()
	b, err := io.ReadAll(out.Body)
	if err != nil {
		return nil, "", fmt.Errorf("%w: read %q: %v", ErrStorage, key, err)
	}
	ct := ""
	if out.ContentType != nil {
		ct = *out.ContentType
	}
	return b, ct, nil
}

// Delete succeeds when the object is not there. AWS S3 answers a delete of
// such a key with no error, but not every store with its API does. The purge
// of a deleted document can meet a blob that a write removed a moment
// before, and must not take that for a failure of the store.
func (s *S3) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err != nil && !isMissingKey(err) {
		return fmt.Errorf("%w: delete %q: %v", ErrStorage, key, err)
	}
	return nil
}

// isMissingKey reports whether the error of a store tells that the object is
// not there. A missing bucket is another error.
func isMissingKey(err error) bool {
	var coded interface{ ErrorCode() string }
	if !errors.As(err, &coded) {
		return false
	}
	return coded.ErrorCode() == "NoSuchKey" || coded.ErrorCode() == "NotFound"
}

// List reads all pages of the listing. It needs permission to list the
// bucket, as Ping does.
func (s *S3) List(ctx context.Context, prefix string) ([]string, error) {
	keys := []string{}
	pages := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{Bucket: aws.String(s.bucket), Prefix: aws.String(prefix)})
	for pages.HasMorePages() {
		page, err := pages.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("%w: list %q: %v", ErrStorage, prefix, err)
		}
		for _, object := range page.Contents {
			if object.Key != nil {
				keys = append(keys, *object.Key)
			}
		}
	}
	// S3 lists in order. Not every store with its API does.
	slices.Sort(keys)
	return keys, nil
}

// isNotFound reports whether an S3 GetObject error represents a missing object.
func isNotFound(err error) bool {
	var nsk *s3types.NoSuchKey
	if errors.As(err, &nsk) {
		return true
	}
	var nf *s3types.NotFound
	return errors.As(err, &nf)
}
